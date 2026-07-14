import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as os from 'os';
import { MainApiClient } from '../api-client/main-api.client';
import { WORKER_CONFIG } from '../config/worker.constants';
import type { WorkerCommandDto } from '../contracts/worker-job.contract';
import { ClipCacheService } from '../storage/clip-cache.service';
import { JobRunnerService } from './job-runner.service';
import { TmpCleanupService } from './tmp-cleanup.service';
import { formatJobContext } from './job-log.util';

@Injectable()
export class PollerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PollerService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly api: MainApiClient,
    private readonly runner: JobRunnerService,
    private readonly tmpCleanup: TmpCleanupService,
    private readonly clipCache: ClipCacheService,
  ) {}

  onModuleInit() {
    const { workerPollIntervalMs, workerId, workerMaxSlots } = WORKER_CONFIG;
    this.timer = setInterval(() => void this.tick(), workerPollIntervalMs);
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), 30_000);
    void this.heartbeat();
    this.logger.log(
      `Worker poller 已启动 id=${workerId} slots=${workerMaxSlots} interval=${workerPollIntervalMs}ms`,
    );
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
  }

  private maxSlots(): number {
    return WORKER_CONFIG.workerMaxSlots;
  }

  private async tick() {
    const capacity = this.maxSlots() - this.running;
    if (capacity <= 0) return;
    const jobs = await this.api.claimJobs(capacity);
    for (const job of jobs) {
      this.running++;
      this.logger.log(`[Claim] ${formatJobContext(job, WORKER_CONFIG.workerId)}`);
      void this.runner.run(job).finally(() => {
        this.running--;
      });
    }
  }

  private async heartbeat() {
    try {
      const tmpDir = this.tmpCleanup.resolveTmpDir();
      const tmpUsage = this.tmpCleanup.scanTmpUsage(tmpDir);
      const clipStats = this.clipCache.scanStats();
      const commands = await this.api.heartbeat(this.running, this.maxSlots(), {
        diskFreeBytes: this.tmpCleanup.resolveDiskFreeBytes(),
        tmpUsedBytes: tmpUsage.tmpUsedBytes,
        tmpDirCount: tmpUsage.dirCount,
        clipCacheBytes: clipStats.totalBytes,
        clipCacheProjectCount: clipStats.projectCount,
        clipCacheFileCount: clipStats.fileCount,
        clipCacheBase: clipStats.cacheBase,
        clipCacheProjects: clipStats.topProjects,
        tmpDir,
        hostname: os.hostname(),
      });
      if (commands.length > 0) {
        await this.executeCommands(commands);
      }
    } catch (err) {
      this.logger.warn(
        `[Heartbeat] 失败 worker=${WORKER_CONFIG.workerId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private async executeCommands(commands: WorkerCommandDto[]) {
    for (const cmd of commands) {
      if (cmd.type !== 'cleanup_tmp') continue;
      try {
        const scope = cmd.scope;
        const result =
          scope === 'clip_cache' || scope === 'clip_cache_all' || scope.startsWith('clip_cache_project:')
            ? this.clipCache.cleanup(scope)
            : this.tmpCleanup.cleanup(scope, this.running, cmd.staleHours ?? 2);
        await this.api.ackCommand(cmd.id, {
          status: 'done',
          freedBytes: result.freedBytes,
          deletedDirs: result.deletedDirs,
          message: result.message,
        });
      } catch (err) {
        await this.api.ackCommand(cmd.id, {
          status: 'failed',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
