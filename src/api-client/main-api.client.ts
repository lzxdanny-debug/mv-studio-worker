import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { AxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';
import type {
  ComposeProgressPayload,
  JobCompleteOutputs,
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

  async heartbeat(runningJobs: number, capacity: number): Promise<void> {
    const { workerId } = WORKER_CONFIG;
    await firstValueFrom(
      this.http.post(
        `${this.baseUrl()}/internal/worker/heartbeat`,
        { workerId, runningJobs, capacity, version: '0.1.0' },
        { headers: this.headers() },
      ),
    );
  }
}
