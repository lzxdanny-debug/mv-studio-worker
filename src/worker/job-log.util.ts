import type { WorkerJobDto } from '../contracts/worker-job.contract';

export function formatJobContext(
  job: Pick<WorkerJobDto, 'jobId' | 'type' | 'projectId' | 'userId' | 'projectTitle'>,
  workerId?: string,
): string {
  const parts = [
    `job=${job.jobId}`,
    `type=${job.type}`,
    job.projectId ? `project=${job.projectId}` : null,
    job.projectTitle ? `title="${job.projectTitle}"` : null,
    job.userId ? `user=${job.userId}` : null,
    workerId ? `worker=${workerId}` : null,
  ].filter(Boolean);
  return parts.join(' ');
}
