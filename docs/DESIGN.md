# mv-studio-worker 设计方案

> 版本：v0.1（设计阶段，未编码）
> 关联：`mv-studio-api`（主服务）、`mv-studio-web`（前端）、`mv-studio-admin`（管理端）

---

## 1. 背景与目标

### 问题
主服务 `mv-studio-api` 的 FFmpeg 视频合成同步阻塞 HTTP，单次 5–30+ 分钟，CPU/内存/磁盘密集。
并发增大时会拖垮 API 的其它接口（登录、列表、AI 轮询），且无法独立扩缩容。

### 目标
1. 把所有重媒体处理（视频/音频/图片）抽到独立服务，与主业务算力隔离
2. 跨网络部署（主服务 K8s，Worker 阿里云），不共享 DB/Redis/队列
3. 支持会员优先级排队 + 全局容量保护
4. Worker 无云凭证、无状态、可水平扩缩
5. 换云渠道时 Worker 零改动

### 非目标
- 不改动 AI 生成编排（Step 2–9 仍在主服务）
- 不迁移计费/通知/鉴权（留主服务）
- 不做 media-core 共享包（初期复制移植）

---

## 2. 总体架构

```
                          用户
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  mv-studio-api（主服务 · K8s）                                │
│                                                              │
│  用户 HTTP：                                                  │
│    POST /mv/projects/:id/compose   → 入队 compose_jobs        │
│    GET  /mv/projects/:id           → 读 job 进度              │
│                                                              │
│  内部 HTTP（供 Worker 调用，Worker API Key 鉴权）：           │
│    POST  /internal/worker/jobs/claim        拉任务            │
│    PATCH /internal/worker/jobs/:id/progress 上报进度         │
│    POST  /internal/worker/jobs/:id/complete 完成            │
│    POST  /internal/worker/jobs/:id/fail     失败            │
│    POST  /internal/worker/heartbeat         存活上报        │
│                                                              │
│  组件：                                                       │
│    QueueAdmissionService  会员优先级 + 并发 + 全局容量        │
│    ComposeJobService      compose_jobs 表 CRUD + claim 原子   │
│    StorageProvider        生成预签名上传/下载 URL（持云密钥） │
│    完成回调：更新 mv_project / 计费结算 / 通知 / 写 mv_asset   │
│                                                              │
│  PostgreSQL（唯一数据源）+ Redis + Stripe + COS 密钥          │
└───────────────────────────┬──────────────────────────────────┘
                            │ HTTPS（出站，Worker → API）
                            │ Pull：claim / progress / complete
┌───────────────────────────┴──────────────────────────────────┐
│  mv-studio-worker（阿里云 · 可多实例）                        │
│                                                              │
│  worker-loop  轮询 claim → 分发 handler → 回调                │
│  handlers/    compose · subtitle · editor · audio · image    │
│  ffmpeg/      spawn + 进度解析 + 滤镜/canvas/调色            │
│  storage/     downloader（拿URL下载）+ uploader（PUT预签名）  │
│  api-client   调主服务 internal API                          │
│                                                              │
│  无 DB / 无 Redis / 无队列 / 无云凭证                        │
│  依赖：ffmpeg(+libass/libx264/libmp3lame) / fontconfig+CJK   │
│        字体 / libvips(sharp) / Node.js / 大容量 /tmp         │
└──────────────────────────────────────────────────────────────┘
```

### 为什么用 Pull 而非 Push / 消息队列
- 跨公网，Worker 在阿里云内网，只需**出站** HTTPS，防火墙简单
- 队列/状态全在主服务 PG，单一数据源，无需引入云消息中间件
- Worker 无固定公网入口也能工作

---

## 3. 通信协议（Internal API 契约）

所有 `/internal/worker/*` 用 `Authorization: Bearer <COMPOSE_WORKER_API_KEY>`（或 HMAC 签名）。
密钥仅存在于主服务与 Worker 环境变量，不下发前端。

### 3.1 claim（原子领取）

```
POST /internal/worker/jobs/claim
Body: { workerId: string, maxSlots: number }

200 {
  jobs: [ WorkerJob ]     // 见 §4
}
204 无任务
```

主服务实现：`SELECT ... FOR UPDATE SKIP LOCKED ORDER BY priority ASC, created_at ASC`，
保证一个 job 只被一个 Worker 领取，标记 `status=running, worker_id, started_at`。

### 3.2 progress（进度上报）

```
PATCH /internal/worker/jobs/:id/progress
Body: { stage: string, percent: number, message: string }
200 { ok: true }
```

主服务写入 `compose_jobs.progress`（JSONB），前端轮询 `GET /mv/projects/:id` 读到。

### 3.3 complete（成功）

```
POST /internal/worker/jobs/:id/complete
Body: {
  outputs: {
    resultUrl: string,           // 成片最终可访问 URL（或 cosKey）
    subtitleBaseUrl?: string,    // 干净版（字幕重渲基线）
    actualDurationSec?: number,
    extra?: Record<string, unknown>
  }
}
200 { ok: true }
```

主服务负责：更新 `mv_project`（resultUrl/status/history）、写 `mv_asset`、计费结算、发通知。

### 3.4 fail（失败）

```
POST /internal/worker/jobs/:id/fail
Body: { error: string, retryable: boolean }
200 { ok: true }
```

`retryable=true` → 主服务重新入队（`retry_count++`，超上限转 failed）；否则直接 failed。

### 3.5 heartbeat（可选，容量感知）

```
POST /internal/worker/heartbeat
Body: { workerId, runningJobs: number, capacity: number, version: string }
```

用于 admin 观察 Worker 存活/负载，及判断僵死任务回收。

---

## 4. Job 契约（payload 全量自包含）

Worker **不查库**，主服务下发所有必要数据 + 预签名 URL。

```ts
type WorkerJobType =
  | 'compose_final'       // 完整合成
  | 'recompose_subtitle'  // 字幕重渲
  | 'render_editor'       // 编辑器渲染
  | 'editor_thumbnails'   // 抽帧缩略图
  | 'audio_compress'      // 音频压缩
  | 'audio_clip'          // 音频切片/截取
  | 'image_optimize';     // 图片优化

interface WorkerJob {
  jobId: string;
  type: WorkerJobType;
  priority: number;                 // 来自 plan_entitlements.queue_priority
  projectId?: string;
  payload: ComposeFinalPayload | AudioPayload | ImagePayload | ...;
  upload: UploadTargets;            // 预签名上传目标
}

// 示例：compose_final
interface ComposeFinalPayload {
  shots: Array<{
    videoUrl: string;               // 下载 URL（COS 公读或预签名）
    duration: number;
    shotIndex: number;
    sceneId?: string;
  }>;
  musicUrl: string;
  musicDuration: number;
  musicStartTime: number;
  aspectRatio: string;              // 16:9 / 9:16 ...
  styleTag?: string;                // 决定调色滤镜
  lrcContent?: string;              // 字幕
  subtitleConfig?: SubtitleConfig;  // 契约类型（见 §7）
  watermarkConfig?: WatermarkConfig | null;
  audioOffsetMs?: number;
}

interface UploadTargets {
  // 方案：主服务下发预签名 PUT URL，Worker 直接 PUT
  resultPutUrl: string;             // 成片上传地址（含临时签名，有效期 2–4h）
  resultPublicUrl: string;          // 上传后对外可访问的最终 URL（回调时带回）
  cleanPutUrl?: string;             // 干净版（compose_final 烧字幕时）
  cleanPublicUrl?: string;
  contentType: string;             // 例 video/mp4，PUT 时 header 必须匹配
}
```

> 契约类型（`WorkerJob*` / `SubtitleConfig` / `WatermarkConfig`）初期在主服务与 Worker
> **各存一份手抄同步**；稳定后如需再抽 `media-core` 薄类型包。

---

## 5. 存储抽象（主服务侧）

目标：换云渠道时 Worker 零改动，主服务屏蔽云差异。

```ts
interface StorageProvider {
  /** 生成预签名 PUT URL（上传） */
  generateUploadUrl(key: string, opts: {
    contentType: string;
    expiresSec: number;
  }): Promise<{ putUrl: string; publicUrl: string }>;

  /** 生成预签名 GET URL（私有桶下载时用；公读桶可直接返回 publicUrl） */
  generateDownloadUrl(key: string, opts?: { expiresSec?: number }): Promise<string>;

  /** key → 公网访问 URL */
  getPublicUrl(key: string): string;
}
```

实现类按云渠道：
- `CosStorageProvider`（腾讯云 · `cos-nodejs-sdk-v5`，现有）
- `OssStorageProvider`（阿里云 · `ali-oss`，未来）
- `S3StorageProvider`（S3/R2 · `@aws-sdk/client-s3`，未来）

admin 配置云渠道 → 主服务据配置选择 Provider。**Worker 永远只认 URL**。

### 预签名注意事项
| 项 | 要求 |
|----|------|
| 有效期 | 合成可能数十分钟，`expiresSec` 设 2–4 小时 |
| Content-Type | 生成时指定，Worker PUT header 必须一致，否则签名失败 |
| 大文件 | 500MB 视频单次 PUT 通常可行；超大再考虑分片（初期不做） |
| 输入下载 | shots/music 用 COS 公读 URL 或预签名 GET；Worker 只 GET |

---

## 6. 会员优先级与排队

复用主服务已有字段（`plan_entitlements`，当前落库未启用）：

| 字段 | 含义 | free | creator | pro |
|------|------|------|---------|-----|
| `queue_priority` | 越小越优先 | 10 | 10 | 5 |
| `max_concurrent_jobs` | 用户并发上限 | 1 | 1–2 | 3 |

### compose_jobs 表（主服务新增）
```sql
CREATE TABLE compose_jobs (
  id             UUID PRIMARY KEY,
  project_id     UUID,
  user_id        UUID NOT NULL,
  type           VARCHAR(20) NOT NULL,
  status         VARCHAR(20) NOT NULL,   -- queued|running|done|failed|cancelled
  priority       INT NOT NULL,           -- 来自 queue_priority
  payload        JSONB NOT NULL,
  progress       JSONB,
  worker_id      VARCHAR(64),
  queue_position INT,
  retry_count    INT DEFAULT 0,
  created_at     TIMESTAMPTZ DEFAULT now(),
  started_at     TIMESTAMPTZ,
  finished_at    TIMESTAMPTZ
);
CREATE INDEX idx_compose_jobs_queue
  ON compose_jobs (status, priority ASC, created_at ASC)
  WHERE status = 'queued';
```

### 入队规则（QueueAdmissionService）
1. 用户并发检查：`running(user) < max_concurrent_jobs` 否则 409
2. 全局容量：`running(global) < COMPOSE_GLOBAL_MAX_RUNNING`；队列满 `COMPOSE_GLOBAL_MAX_QUEUED` 返回 503
3. 计算 `queue_position`（同 priority 内 FIFO）
4. 入队，返回 `{ jobId, queuePosition, estimatedWaitSec }`

### claim 排序
```sql
ORDER BY priority ASC, created_at ASC   -- pro(5) 先于 free(10)
```

### 前端排队展示
`GET /mv/projects/:id` 的 `composeProgress`：
```json
{ "stage": "queued", "percent": 0, "message": "排队中，前方 2 位",
  "queuePosition": 3, "estimatedWaitSec": 240 }
```
`stage=queued` 展示排队 UI；`running` 后展示进度条。

---

## 7. 共享契约类型（初期手抄）

两边都需要、需保持一致的类型（**非 FFmpeg 逻辑**）：

| 类型 | 主服务用途 | Worker 用途 |
|------|-----------|-------------|
| `WorkerJob` / `WorkerJobType` | 构造下发 | 解析执行 |
| `SubtitleConfig` | API 校验 + 存 DB | 渲染 ASS |
| `WatermarkConfig` | 读 DB 下发 | 烧录水印 |
| `CompressionParams` | admin 配置下发 | 执行压缩 |
| progress / complete / fail DTO | 接收 | 上报 |

同步策略：初期两仓库各存一份，改动时人工对齐（量小）。若频繁漂移，再抽 `@mv-studio/media-core` 薄类型包（只含 interface + 校验，不含逻辑）。

---

## 8. Worker 目录结构（规划）

```
mv-studio-worker/
├── src/
│   ├── main.ts                     # 启动 worker loop
│   ├── config/                     # env 配置（API 地址、Worker Key、并发数）
│   ├── worker/
│   │   ├── poller.service.ts       # 轮询 claim → 分发 → 回调
│   │   ├── job-runner.service.ts   # 按 type 路由 handler
│   │   └── heartbeat.service.ts
│   ├── handlers/
│   │   ├── compose.handler.ts      # compose_final
│   │   ├── subtitle.handler.ts     # recompose_subtitle
│   │   ├── editor.handler.ts       # render_editor / editor_thumbnails
│   │   ├── audio.handler.ts        # audio_compress / audio_clip
│   │   └── image.handler.ts        # image_optimize
│   ├── ffmpeg/
│   │   ├── ffmpeg-runner.ts        # spawn + stderr time= 进度解析
│   │   ├── probe.ts                # ffprobe
│   │   ├── filters.ts              # 调色 / fade / scale-crop
│   │   ├── canvas.ts               # getCanvasSize
│   │   └── ass-builder.ts          # 字幕 ASS 生成
│   ├── image/
│   │   └── sharp-optimizer.ts
│   ├── storage/
│   │   ├── downloader.ts           # 拿 URL 下载 + 重试
│   │   └── uploader.ts             # PUT 预签名 URL
│   ├── api-client/
│   │   └── main-api.client.ts      # 调主服务 internal API
│   └── contracts/                  # 手抄的契约类型（§7）
├── Dockerfile
├── package.json                    # 瘦身依赖
├── nest-cli.json
├── tsconfig.json
└── docs/                           # 本设计文档
```

---

## 9. 依赖清单

### Worker package.json（预估）
```
dependencies:
  @nestjs/common / core / config      # 框架
  @nestjs/axios (或 axios)            # 调主服务
  sharp                               # P2 图片
  uuid
devDependencies:
  @nestjs/cli, typescript, ts-node, @types/*
```
**不装**：typeorm/pg/ioredis/bullmq/stripe/passport/cos-sdk/@alicloud/* 等。

### Worker Docker 系统依赖
```dockerfile
FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg fontconfig fonts-noto-cjk fonts-wqy-microhei libvips42 \
    && rm -rf /var/lib/apt/lists/*
```

---

## 10. 主服务侧改动概览

| 模块 | 改动 |
|------|------|
| `compose_jobs` 实体 + migration | 新增 |
| `QueueAdmissionService` | 新增：会员优先级/并发/全局容量 |
| `ComposeJobService` | 新增：入队 + claim 原子 + 状态机 |
| `StorageProvider` 抽象 | 新增：预签名生成，`CosStorageProvider` 先实现 |
| `/internal/worker/*` controller | 新增：claim/progress/complete/fail/heartbeat + Key 鉴权 |
| `mv.controller.ts` compose 入口 | 改：同步 await → 入队返回 202 |
| `getComposeProgress` | 改：内存 → 读 compose_jobs.progress |
| complete 回调处理 | 迁：结算/通知/写库从原同步流程搬到回调 |
| FFmpeg/sharp 代码 | 迁移验证后**删除** |
| 推荐路径音频截取 | **保留**最小 ffmpeg（不进 Worker） |

---

## 11. 环境变量

### 主服务新增
```
COMPOSE_WORKER_API_KEY=<共享密钥>
COMPOSE_GLOBAL_MAX_RUNNING=4
COMPOSE_GLOBAL_MAX_QUEUED=50
COMPOSE_PRESIGN_EXPIRES_SEC=14400   # 4h
```

### Worker
```
MAIN_API_BASE_URL=https://studio-api.xxx.com
COMPOSE_WORKER_API_KEY=<同上>
WORKER_ID=worker-01
WORKER_MAX_SLOTS=2                   # 单实例并发 FFmpeg 数
WORKER_POLL_INTERVAL_MS=3000
FFMPEG_PATH=ffmpeg
FFPROBE_PATH=ffprobe
TMP_DIR=/tmp
```

---

## 12. 容量与调优（基于压测脚本 benchmark-compose-cpu.mjs）

- 实时因子（编码耗时/成片时长）真实素材约 1.5–2.5
- 安全并发 ≈ 核数 / 实时因子（如 4 核 → 约 2 路）
- 单路峰值内存 100–400MB，/tmp 1–4GB
- `WORKER_MAX_SLOTS` 建议 = 安全并发；实例数按队列深度扩缩

---

## 13. 风险与对策

| 风险 | 对策 |
|------|------|
| 任务领取后 Worker 崩溃 | started_at 超时未完成 → 主服务回收重入队 |
| 预签名过期（超长合成） | expiresSec 设足够长；complete 若上传失败 fail(retryable) |
| 推荐同步延迟 | 音频截取保留主服务 ffmpeg，不走 Worker 队列 |
| 契约漂移 | 初期手抄 + 集成测试；频繁则抽 media-core |
| 换云渠道 | StorageProvider 抽象，Worker 不动 |
| 全局资源打满 | COMPOSE_GLOBAL_MAX_RUNNING/QUEUED 上限保护 |

---

## 14. 分阶段落地（详见 MIGRATION-CHECKLIST.md）

1. **阶段 1**：主服务队列化（compose_jobs + admission + internal API + 前端异步），
   合成仍在主服务进程内消费，验证契约
2. **阶段 2**：新建 Worker，移植 P0 FFmpeg，主服务停止本地消费改由 Worker claim
3. **阶段 3**：纳入 P1 音频、P2 图片；多实例 + heartbeat + 监控；主服务删 FFmpeg
