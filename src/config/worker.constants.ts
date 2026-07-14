/**
 * Worker 运行时配置（修改本文件即可，无需 .env）
 *
 * 部署到测试/生产时改 mainApiBaseUrl、workerApiKey；
 * 多实例扩容时改 workerId；算力允许时再提高 workerMaxSlots。
 */
export const WORKER_CONFIG = {
  /** 主服务地址，不含 /api 前缀 */
  mainApiBaseUrl: 'http://localhost:4001',
  /** 与 API 的 COMPOSE_WORKER_API_KEY 一致 */
  workerApiKey: '6bcd8344-5853-48bb-83b0-3fc3c991e409',
  /** 本实例标识，多 Worker 时须唯一 */
  workerId: 'local-dev-01',
  /** 本机同时处理的合成任务数 */
  workerMaxSlots: 1,
  /** claim 轮询间隔（毫秒） */
  workerPollIntervalMs: 3000,
  ffmpegPath: 'ffmpeg',
  ffprobePath: 'ffprobe',
  tmpDir: '/tmp',
  /** 片段持久缓存目录；空字符串表示 ~/.mv-worker-cache */
  clipCacheDir: '',
} as const;
