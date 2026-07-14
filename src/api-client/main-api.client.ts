import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { AxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';
import type {
  ComposeProgressPayload,
  JobCompleteOutputs,
  WorkerCommandDto,
  WorkerHeartbeatResponse,
  WorkerJobDto,
} from '../contracts/worker-job.contract';
import { WORKER_CONFIG } from '../config/worker.constants';
import { formatJobContext } from '../worker/job-log.util';

function formatHttpError(err: unknown, action: string, url: string): string {
  if (err instanceof AxiosError) {
    const status = err.response?.status;
    const data = err.response?.data;
    const detail =
      typeof data === 'string'
        ? data.slice(0, 200)
        : data && typeof data === 'object' && 'message' in data
          ? String((data as { message: unknown }).message)
          : '';
    const code = err.code ?? '';
    const parts = [`${action} ${url}`];
    if (status) parts.push(`status=${status}`);
    if (code) parts.push(`code=${code}`);
    if (detail) parts.push(detail);
    if (parts.length === 1) parts.push(err.message || '未知网络错误');
    return parts.join(' · ');
  }
  if (err instanceof Error) return err.message || String(err);
  return String(err);
}

@Injectable()
export class MainApiClient {
  private readonly logger = new Logger(MainApiClient.name);

  constructor(private readonly http: HttpService) {}

  private baseUrl(): string {
    return WORKER_CONFIG.mainApiBaseUrl.replace(/\/$/, '');
  }

  private headers() {
    return {
      Authorization: `Bearer ${WORKER_CONFIG.workerApiKey}`,
      'Content-Type': 'application/json',
    };
  }

  async claimJobs(maxSlots: number): Promise<WorkerJobDto[]> {
    const { workerId } = WORKER_CONFIG;
    try {
      const res = await firstValueFrom(
        this.http.post(
          `${this.baseUrl()}/internal/worker/jobs/claim`,
          { workerId, maxSlots },
          { headers: this.headers(), validateStatus: (s) => s === 200 || s === 204 },
        ),
      );
      if (res.status === 204) return [];
      const body = res.data as { jobs?: WorkerJobDto[]; data?: { jobs?: WorkerJobDto[] } } | undefined;
      const jobs = body?.jobs ?? body?.data?.jobs ?? [];
      if (jobs.length > 0) {
        this.logger.log(
          `[HTTP] POST /internal/worker/jobs/claim ← ${jobs.length} job(s): ` +
          jobs.map((j) => formatJobContext(j, workerId)).join('; '),
        );
      }
      return jobs;
    } catch (err) {
      this.logger.warn(formatHttpError(err, 'claim 失败', `${this.baseUrl()}/internal/worker/jobs/claim`));
      return [];
    }
  }

  async updateProgress(jobId: string, progress: ComposeProgressPayload): Promise<void> {
    await firstValueFrom(
      this.http.patch(
        `${this.baseUrl()}/internal/worker/jobs/${jobId}/progress`,
        progress,
        { headers: this.headers() },
      ),
    );
  }

  async complete(jobId: string, outputs: JobCompleteOutputs): Promise<void> {
    this.logger.log(`[HTTP] POST /internal/worker/jobs/${jobId}/complete result=${outputs.resultUrl?.slice(0, 80) ?? 'n/a'}`);
    await firstValueFrom(
      this.http.post(
        `${this.baseUrl()}/internal/worker/jobs/${jobId}/complete`,
        { outputs },
        { headers: this.headers() },
      ),
    );
  }

  async fail(jobId: string, error: string, retryable = true): Promise<void> {
    this.logger.warn(`[HTTP] POST /internal/worker/jobs/${jobId}/fail retryable=${retryable} error=${error.slice(0, 120)}`);
    await firstValueFrom(
      this.http.post(
        `${this.baseUrl()}/internal/worker/jobs/${jobId}/fail`,
        { error, retryable },
        { headers: this.headers() },
      ),
    );
  }

  async heartbeat(
    runningJobs: number,
    capacity: number,
    stats?: {
      diskFreeBytes?: number;
      tmpUsedBytes?: number;
      tmpDirCount?: number;
      clipCacheBytes?: number;
      clipCacheProjectCount?: number;
      clipCacheFileCount?: number;
      clipCacheBase?: string;
      clipCacheProjects?: Array<{
        projectId: string;
        bytes: number;
        fileCount: number;
        lastAccessAt: string | null;
      }>;
      tmpDir?: string;
      hostname?: string;
    },
  ): Promise<WorkerCommandDto[]> {
    const { workerId } = WORKER_CONFIG;
    try {
      const res = await firstValueFrom(
        this.http.post<WorkerHeartbeatResponse>(
          `${this.baseUrl()}/internal/worker/heartbeat`,
          {
            workerId,
            runningJobs,
            capacity,
            version: '0.2.0',
            diskFreeBytes: stats?.diskFreeBytes,
            tmpUsedBytes: stats?.tmpUsedBytes,
            tmpDirCount: stats?.tmpDirCount,
            clipCacheBytes: stats?.clipCacheBytes,
            clipCacheProjectCount: stats?.clipCacheProjectCount,
            clipCacheFileCount: stats?.clipCacheFileCount,
            clipCacheBase: stats?.clipCacheBase,
            clipCacheProjects: stats?.clipCacheProjects,
            tmpDir: stats?.tmpDir,
            hostname: stats?.hostname,
          },
          { headers: this.headers() },
        ),
      );
      const body = res.data as WorkerHeartbeatResponse & { data?: WorkerHeartbeatResponse };
      return body.commands ?? body.data?.commands ?? [];
    } catch (err) {
      this.logger.warn(formatHttpError(err, 'heartbeat 失败', `${this.baseUrl()}/internal/worker/heartbeat`));
      return [];
    }
  }

  async ackCommand(
    commandId: string,
    payload: {
      status: 'done' | 'failed';
      freedBytes?: number;
      deletedDirs?: number;
      message?: string;
    },
  ): Promise<void> {
    const { workerId } = WORKER_CONFIG;
    await firstValueFrom(
      this.http.post(
        `${this.baseUrl()}/internal/worker/commands/${commandId}/ack`,
        { workerId, ...payload },
        { headers: this.headers() },
      ),
    );
  }
}
