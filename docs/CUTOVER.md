# 本机 Worker 灰度切换指南

## 前置条件

1. 测试 API 已部署阶段1代码（`compose_jobs` 表 + Internal API）
2. 两端配置相同的 `COMPOSE_WORKER_API_KEY`
3. 本机已安装 `ffmpeg` / `ffprobe`（含 libass）

```bash
# 主服务 migration
cd mv-studio-api && pnpm migration:run
```

## 环境变量

### 测试 API（PM2 `.env`）

```bash
COMPOSE_WORKER_API_KEY=<随机串>
COMPOSE_CONSUMER_MODE=worker    # 切换为 worker 模式
COMPOSE_GLOBAL_MAX_RUNNING=4
COMPOSE_GLOBAL_MAX_QUEUED=50
```

### 本机 Worker（`.env` 已废弃，改 `src/config/worker.constants.ts`）

```typescript
// mainApiBaseUrl、workerApiKey 与测试 API 一致
```

## 启动 Worker

```bash
cd mv-studio-worker
cp .env.example .env   # 填入上述变量
pnpm install
pnpm dev
```

## 验证 Internal API 可达

```bash
curl -s -o /dev/null -w "%{http_code}" \
  -X POST "https://<测试API>/internal/worker/jobs/claim" \
  -H "Authorization: Bearer <COMPOSE_WORKER_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"workerId":"curl-test","maxSlots":1}'
# 期望 204（无任务）或 200（有任务）
```

## 灰度流程

1. **基线**：`COMPOSE_CONSUMER_MODE=local`，跑一个项目完成 compose → 记录 `resultUrl` / 时长
2. **切换**：测试 API 设 `COMPOSE_CONSUMER_MODE=worker`，重启 PM2
3. **联调**：本机启动 Worker，对同一项目触发 compose / recompose / editor / thumbnails
4. **比对**：检查 4 类任务产物（画面、时长、字幕、编辑器图层）与 local 模式一致
5. **回滚**：`COMPOSE_CONSUMER_MODE=local`，停本机 Worker

## 模式说明

| `COMPOSE_CONSUMER_MODE` | 行为 |
|-------------------------|------|
| `local`（默认） | API 内 `ComposeJobConsumerService` 消费，可回滚 |
| `worker` | 仅入队，由外部 Worker claim + complete |

## 故障排查

- **claim 401**：`COMPOSE_WORKER_API_KEY` 不一致
- **claim 连不上**：确认 `/internal/worker/*` 未被反向代理拦截（global prefix 已排除 `internal/(.*)`）
- **上传失败**：检查预签名 URL 是否过期（默认 4h：`COMPOSE_PRESIGN_EXPIRES_SEC=14400`）
- **任务僵死**：主服务 `ComposeJobService.recoverStaleJobs` 每 5 分钟回收超时任务
