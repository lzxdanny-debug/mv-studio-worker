#!/usr/bin/env node
/**
 * 本机 Worker 联调冒烟脚本：验证 Internal API claim/heartbeat 可达。
 *
 * 读取 src/config/worker.constants.ts（与 Worker 进程同源配置）。
 * 用法：node --experimental-strip-types scripts/smoke-internal-api.mjs
 */
import { WORKER_CONFIG } from '../src/config/worker.constants.ts';

const base = WORKER_CONFIG.mainApiBaseUrl.replace(/\/$/, '');
const key = WORKER_CONFIG.workerApiKey;
if (!key) {
  console.error('workerApiKey 未配置');
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${key}`,
  'Content-Type': 'application/json',
};

async function req(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

const claim = await req('POST', '/internal/worker/jobs/claim', { workerId: 'smoke-test', maxSlots: 1 });
console.log('claim:', claim.status, claim.data ?? '(empty)');

const hb = await req('POST', '/internal/worker/heartbeat', {
  workerId: 'smoke-test',
  runningJobs: 0,
  capacity: 1,
  version: 'smoke',
});
console.log('heartbeat:', hb.status, hb.data);

if (claim.status === 401) {
  console.error('FAIL: API Key 无效');
  process.exit(1);
}
if (claim.status !== 200 && claim.status !== 204) {
  console.error('FAIL: claim 异常状态', claim.status);
  process.exit(1);
}
console.log('OK: Internal API 可达');
