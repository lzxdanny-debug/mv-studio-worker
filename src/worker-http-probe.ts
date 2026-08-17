import { createServer } from 'node:http';
import { BUILD_INFO } from './generated/build-info';

/** 可选 HTTP 探针：GET /health /version（默认端口 9090，WORKER_HTTP_PORT=0 关闭） */
export function startWorkerHttpProbe(logger: { log: (msg: string) => void }) {
  const raw = process.env.WORKER_HTTP_PORT ?? '9090';
  const port = parseInt(raw, 10);
  if (!Number.isFinite(port) || port <= 0) return;

  const server = createServer((req, res) => {
    const path = req.url?.split('?')[0] ?? '';
    if (path === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
      return;
    }
    if (path === '/version' || path === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(BUILD_INFO));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  server.listen(port, '127.0.0.1', () => {
    logger.log(
      `Worker HTTP 探针 http://127.0.0.1:${port}/version · v${BUILD_INFO.version} (${BUILD_INFO.gitSha})`,
    );
  });
}
