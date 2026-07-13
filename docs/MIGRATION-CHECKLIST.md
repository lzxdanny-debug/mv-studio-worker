# 落地清单（Migration Checklist）

分三阶段。每阶段可独立上线、可回滚。全程 `[ ]` 未做 / `[x]` 完成。

---

## 阶段 0 · 准备与决策（无代码）

- [ ] 确认 Worker 框架 = NestJS（瘦身版）
- [ ] 确认通信 = Pull（claim/progress/complete/fail）
- [ ] 确认上传 = 主服务预签名 URL，Worker 零凭证
- [ ] 确认共享 = 复制移植 + 契约手抄（不建 media-core）
- [ ] 确认推荐路径音频截取保留主服务
- [ ] 跑 `benchmark-compose-cpu.mjs` 得实时因子/内存/磁盘 → 定 `WORKER_MAX_SLOTS`
- [ ] 约定 `COMPOSE_WORKER_API_KEY` 分发方式

---

## 阶段 1 · 主服务队列化（合成仍在主服务进程消费）

目标：先把同步阻塞改成异步队列，验证契约与前端体验，Worker 还没上。

### 数据层
- [ ] 新增 `compose_jobs` 实体 + migration（含 queue 索引）
- [ ] 校验 `plan_entitlements.queue_priority / max_concurrent_jobs` 有默认值

### 服务层
- [ ] `QueueAdmissionService`：用户并发 + 全局容量 + queue_position
- [ ] `ComposeJobService`：入队 / claim(FOR UPDATE SKIP LOCKED) / 状态机 / 超时回收
- [ ] `StorageProvider` 抽象 + `CosStorageProvider`（预签名 PUT/GET）

### 接口层
- [ ] compose 入口：同步 await → 入队返回 202 `{jobId,queuePosition}`
- [ ] `getComposeProgress`：读 `compose_jobs.progress`（含 queued 态）
- [ ] `/internal/worker/*`：claim/progress/complete/fail/heartbeat + Key 鉴权守卫

### 临时消费者（本阶段用，阶段 2 删）
- [ ] 主服务内 in-process consumer 调现有 `composeFinalMv` 消费队列
- [ ] 完成回调逻辑落地：结算/通知/写 mv_asset/更新 project（从原同步流程搬入回调）

### 前端
- [ ] compose 触发后进入轮询；`stage=queued` 展示排队位次
- [ ] `running` 展示进度条；`done/failed` 处理
- [ ] 会员并发上限命中(409)/队列满(503) 的提示

### 验收
- [ ] 合成异步化，其它接口不受阻塞
- [ ] 排队按会员优先级生效
- [ ] 进度/成片/失败/重试全链路正常

---

## 阶段 2 · 新建 Worker，接管 P0 FFmpeg

### Worker 骨架
- [ ] `mv-studio-worker` NestJS 工程 + 瘦身依赖
- [ ] Dockerfile（ffmpeg + fontconfig + noto-cjk/wqy 字体 + libvips）
- [ ] config：env 加载与校验
- [ ] `poller.service`：claim → runner → 回调；`heartbeat.service`
- [ ] `api-client`：调主服务 internal API（重试/超时）
- [ ] `storage/downloader` + `storage/uploader`(PUT 预签名，Content-Type 对齐)

### 移植 P0（对照 EXTRACTION-INVENTORY 🟢）
- [ ] `ffmpeg-runner`（spawn + time= 进度）+ `probe`
- [ ] `canvas.ts` / `filters.ts` / `ass-builder.ts`
- [ ] `compose.handler`（compose_final）
- [ ] `subtitle.handler`（recompose_subtitle）
- [ ] `editor.handler`（render_editor + editor_thumbnails）
- [ ] 启动自检（字体/滤镜可用性，对应原 diagnose）

### 契约
- [ ] `contracts/` 手抄 WorkerJob / SubtitleConfig / WatermarkConfig / DTO
- [ ] 与主服务字段逐一比对

### 切换
- [ ] 灰度：部分 job 由 Worker claim，比对产物与旧同步一致（画面/时长/字幕/水印/调色）
- [ ] 移除主服务 in-process consumer，合成全量走 Worker
- [ ] 主服务 compose 相关重 FFmpeg 代码标记待删（先注释/开关，稳定后删）

### 验收
- [ ] 跨网络 claim/回调稳定；Worker 崩溃任务可回收重入队
- [ ] 预签名上传成功；换实例无状态影响
- [ ] 产物与旧流程一致

---

## 阶段 3 · 纳入 P1/P2 + 生产化

- [ ] `audio.handler`：audio_compress / audio_clip（P1）
- [ ] `wan-video` 音频段截取迁 Worker
- [ ] `image.handler`：image_optimize（sharp，P2）
- [ ] 主服务图片优化改为下发 image_optimize job
- [ ] 推荐路径音频截取按决策保留主服务最小 ffmpeg（不进 Worker）
- [ ] 主服务删除已迁移的 FFmpeg/sharp 重逻辑与无用依赖
- [ ] 多 Worker 实例 + 水平扩缩；heartbeat 面板
- [ ] 监控告警：队列深度/等待时长/失败率/实例 CPU 内存磁盘
- [ ] admin：Worker 存活/负载 + compose_jobs 运维视图
- [ ] 压测：目标并发下容量与延迟达标

### 终态验收
- [ ] 主服务基本无重 FFmpeg 负载，接口稳定
- [ ] Worker 独立扩缩，算力隔离
- [ ] 换云渠道 Worker 零改动（StorageProvider 生效）

---

## 回滚策略
- 阶段 1：入口开关切回同步 await
- 阶段 2：重启 in-process consumer，停 Worker claim
- 阶段 3：单独关某类 job type 回退到主服务处理
