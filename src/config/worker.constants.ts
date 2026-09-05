import 'dotenv/config';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`缺少必填环境变量 ${name}，Worker 已拒绝启动`);
  }
  return value;
}

/**
 * Worker 运行时配置。
 *
 * 部署到测试/生产时通过环境变量注入密钥；
 * 多实例扩容时改 workerId；算力允许时再提高 workerMaxSlots。
 */
export const WORKER_CONFIG = {
  /** 主服务地址，不含 /api 前缀 */
  mainApiBaseUrl: 'http://localhost:4001',
  /** 与 API 的 COMPOSE_WORKER_API_KEY 一致 */
  workerApiKey: requiredEnv('COMPOSE_WORKER_API_KEY'),
  /** 本实例标识，多 Worker 时须唯一 */
  workerId: 'local-dev-01',
  /** 本机同时处理的合成任务数 */
  workerMaxSlots: 1,
  /** AI MV 渠道任务独立槽位；不会占用本机 FFmpeg 合成槽位 */
  aimvWorkerMaxSlots: 10,
  /** AI MV claim 租约秒数，执行中会定期续租 */
  aimvLeaseSeconds: 90,
  /**
   * AI MV execute 最长等待。API 分镜默认可跑 1800s，再加上视频生成，
   * 必须大于正常耗时；到期必须释放内存槽位并停止续租，否则进程假活后永远不 claim。
   */
  aimvExecuteTimeoutMs: 90 * 60 * 1000,
  /** 到期文件清理是轻量 I/O 任务，使用独立槽位 */
  aimvCleanupMaxSlots: 2,
  aimvCleanupLeaseSeconds: 120,
  /** claim 轮询间隔（毫秒） */
  workerPollIntervalMs: 3000,
  ffmpegPath: 'ffmpeg',
  ffprobePath: 'ffprobe',
  tmpDir: '/tmp',
  /** 片段持久缓存目录；空字符串表示 ~/.mv-worker-cache */
  clipCacheDir: '',
} as const;
