import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WORKER_CONFIG } from '../config/worker.constants';
import type { WorkerCleanupScope } from '../contracts/worker-job.contract';

const WORKER_TMP_PREFIX = 'mv-worker-';

@Injectable()
export class TmpCleanupService {
  private readonly logger = new Logger(TmpCleanupService.name);

  resolveTmpDir(): string {
    return WORKER_CONFIG.tmpDir || os.tmpdir();
  }

  scanTmpUsage(tmpDir = this.resolveTmpDir()): { tmpUsedBytes: number; dirCount: number } {
    let tmpUsedBytes = 0;
    let dirCount = 0;
    if (!fs.existsSync(tmpDir)) return { tmpUsedBytes, dirCount };

    for (const name of fs.readdirSync(tmpDir)) {
      if (!name.startsWith(WORKER_TMP_PREFIX)) continue;
      const full = path.join(tmpDir, name);
      if (!fs.statSync(full).isDirectory()) continue;
      dirCount++;
      tmpUsedBytes += this.dirBytes(full);
    }
    return { tmpUsedBytes, dirCount };
  }

  resolveDiskFreeBytes(): number | undefined {
    try {
      // Node 18+；失败则不上报
      const stat = fs.statfsSync?.(this.resolveTmpDir());
      if (!stat) return undefined;
      const free = Number(stat.bfree) * Number(stat.bsize);
      return Number.isFinite(free) ? free : undefined;
    } catch {
      return undefined;
    }
  }

  cleanup(
    scope: WorkerCleanupScope,
    runningJobs: number,
    staleHours = 2,
  ): { freedBytes: number; deletedDirs: number; message: string } {
    const tmpDir = this.resolveTmpDir();
    if (!fs.existsSync(tmpDir)) {
      return { freedBytes: 0, deletedDirs: 0, message: 'tmp 目录不存在' };
    }

    if (scope === 'all_tmp' && runningJobs > 0) {
      return {
        freedBytes: 0,
        deletedDirs: 0,
        message: '有任务进行中，已跳过 all_tmp 清理',
      };
    }

    const staleMs = staleHours * 60 * 60 * 1000;
    const projectPrefix = scope.startsWith('project:') ? `mv-worker-${scope.slice('project:'.length)}-` : null;
    let freedBytes = 0;
    let deletedDirs = 0;
    const skipped: string[] = [];

    for (const name of fs.readdirSync(tmpDir)) {
      if (!name.startsWith(WORKER_TMP_PREFIX)) continue;
      if (projectPrefix && !name.startsWith(projectPrefix)) continue;

      const full = path.join(tmpDir, name);
      if (!fs.statSync(full).isDirectory()) continue;
      const stat = fs.statSync(full);
      const ageMs = Date.now() - Math.max(stat.mtimeMs, stat.ctimeMs);

      if (scope === 'stale' && ageMs < staleMs) {
        skipped.push(name);
        continue;
      }
      if (scope === 'all_tmp' && runningJobs > 0) continue;

      const bytes = this.dirBytes(full);
      try {
        fs.rmSync(full, { recursive: true, force: true });
        freedBytes += bytes;
        deletedDirs++;
      } catch (err) {
        this.logger.warn(`[TmpCleanup] 删除失败 ${full}: ${err instanceof Error ? err.message : err}`);
      }
    }

    const message =
      scope === 'stale'
        ? `清理过期临时目录 ${deletedDirs} 个，跳过 ${skipped.length} 个`
        : `清理临时目录 ${deletedDirs} 个`;
    this.logger.log(`[TmpCleanup] scope=${scope} freed=${freedBytes} dirs=${deletedDirs}`);
    return { freedBytes, deletedDirs, message };
  }

  private dirBytes(dir: string): number {
    let bytes = 0;
    const walk = (current: string) => {
      for (const name of fs.readdirSync(current)) {
        const full = path.join(current, name);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) walk(full);
        else bytes += stat.size;
      }
    };
    walk(dir);
    return bytes;
  }
}
