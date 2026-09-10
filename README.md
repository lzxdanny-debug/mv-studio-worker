# mv-studio-worker

MV Studio 独立媒体处理服务（Media Worker）。

主服务 `mv-studio-api` 把所有 CPU/系统依赖密集的媒体任务（FFmpeg 视频合成、字幕烧录、
编辑器渲染、抽帧）抽离到本服务，通过 **HTTPS Pull 模式** 跨网络协作。

## 快速启动（本机开发）

```bash
# 也可以把以下变量写入项目根目录的 .env
export MAIN_API_BASE_URL=http://localhost:4001
export WORKER_ID=local-dev-01
export COMPOSE_WORKER_API_KEY=<与主API一致的密钥>
export WORKER_COMPOSE_MAX_SLOTS=4
export WORKER_AIMV_MAX_SLOTS=20
export WORKER_CLEANUP_MAX_SLOTS=2
pnpm install
pnpm dev
```

三类槽位相互独立，均可按服务器能力调整；设为 `0` 可关闭该类任务。旧的
`WORKER_MAX_SLOTS` 仍可作为合成槽位的兼容配置。

冒烟验证 Internal API：

```bash
node --experimental-strip-types scripts/smoke-internal-api.mjs
```

灰度切换详见 [docs/CUTOVER.md](docs/CUTOVER.md)。

## 工程结构

```
src/
  main.ts
  config/
  worker/          poller + job-runner
  api-client/      调主服务 internal API
  storage/         downloader + uploader(预签名PUT)
  contracts/       WorkerJob / Payload / DTO
  ffmpeg/          runner + compose-pipeline + editor-overlay + subtitle-burn
  handlers/        compose / subtitle / editor / editor-thumbnails
```

## 定位

- **纯算力服务**：只做媒体处理，无业务逻辑、无数据库、无队列、无云凭证
- **完全独立**：独立仓库、独立部署（阿里云），与主服务仅通过 HTTP 通信
- **无状态**：任务与状态全在主服务，Worker 可随意水平扩缩

## 承担的能力

| 分类 | 来源（主服务） | 说明 |
|------|----------------|------|
| P0 视频合成 | `mv-composition.service.ts` | 合成 / 字幕重渲 / 编辑器渲染 / 抽帧 / 水印 |
| P1 音频处理 | `audio-compression` / `gemini-audio` / `wan-video` | 压缩 / 切片 / 截取 |
| P2 图片优化 | `cos.service.ts` | sharp 压缩转码 |

## 关键设计决策（已拍板）

1. 框架：**NestJS**（瘦身版，只装必要依赖）
2. 通信：**Pull 模式**（Worker 轮询主服务拉任务 + 回调进度/结果）
3. 上传：**主服务下发预签名 URL**，Worker 零云凭证
4. 共享代码：**先复制移植**，不建 media-core（契约类型初期手抄同步）
5. 会员排队：主服务 `plan_entitlements.queue_priority` / `max_concurrent_jobs` 驱动
6. 推荐路径的音频截取：**保留在主服务的最小 ffmpeg**，不进 Worker（避免同步延迟）

## 文档索引

| 文档 | 内容 |
|------|------|
| [docs/DESIGN.md](docs/DESIGN.md) | 总体架构、通信协议、Job 契约、存储抽象、部署 |
| [docs/MIGRATION-CHECKLIST.md](docs/MIGRATION-CHECKLIST.md) | 分阶段落地清单（主服务侧 + Worker 侧） |
| [docs/CUTOVER.md](docs/CUTOVER.md) | 本机 Worker 灰度切换与联调 |
