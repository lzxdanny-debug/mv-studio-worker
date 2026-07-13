import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { MainApiClient } from '../api-client/main-api.client';
import { WORKER_CONFIG } from '../config/worker.constants';
import { JobRunnerService } from './job-runner.service';
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
  ) {}

  onModuleInit() {
    const { workerPollIntervalMs, workerId, workerMaxSlots } = WORKER_CONFIG;
    this.timer = setInterval(() => void this.tick(), workerPollIntervalMs);
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), 30_000);
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
    if (this.running <= 0) return;
    try {
      await this.api.heartbeat(this.running, this.maxSlots());
      this.logger.debug(
        `[Heartbeat] worker=${WORKER_CONFIG.workerId} running=${this.running}/${this.maxSlots()}`,
      );
    } catch (err) {
      this.logger.warn(
        `[Heartbeat] 失败 worker=${WORKER_CONFIG.workerId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
