import { Injectable, Logger } from '@nestjs/common';
import type { ComposeProgressPayload, JobCompleteOutputs, WorkerJobDto } from '../contracts/worker-job.contract';
import { WORKER_CONFIG } from '../config/worker.constants';
import { MainApiClient } from '../api-client/main-api.client';
import { ComposeHandler } from '../handlers/compose.handler';
import { SubtitleHandler } from '../handlers/subtitle.handler';
import { EditorHandler } from '../handlers/editor.handler';
import { EditorThumbnailsHandler } from '../handlers/editor-thumbnails.handler';
import { PrepareKaraokeAudioHandler } from '../handlers/prepare-karaoke-audio.handler';
import { ExtractKaraokeFrameHandler } from '../handlers/extract-karaoke-frame.handler';
import { ComposeKaraokeHandler } from '../handlers/compose-karaoke.handler';
import { formatJobContext } from './job-log.util';

@Injectable()
export class JobRunnerService {
  private readonly logger = new Logger(JobRunnerService.name);

  constructor(
    private readonly api: MainApiClient,
    private readonly composeHandler: ComposeHandler,
    private readonly subtitleHandler: SubtitleHandler,
    private readonly editorHandler: EditorHandler,
    private readonly thumbnailsHandler: EditorThumbnailsHandler,
    private readonly prepareKaraokeAudioHandler: PrepareKaraokeAudioHandler,
    private readonly extractKaraokeFrameHandler: ExtractKaraokeFrameHandler,
    private readonly composeKaraokeHandler: ComposeKaraokeHandler,
  ) {}

  private workerId(): string {
    return WORKER_CONFIG.workerId;
  }

  async run(job: WorkerJobDto): Promise<void> {
    const ctx = () => formatJobContext(job, this.workerId());
    let lastStage = '';
    let leaseTimer: NodeJS.Timeout | null = null;

    if (job.type === 'compose_aimv') {
      if (!job.attemptToken) {
        throw new Error(`AIMV 合成任务 ${job.jobId} 缺少 attempt token`);
      }
      const leaseSeconds = job.leaseSeconds ?? WORKER_CONFIG.composeAimvLeaseSeconds;
      leaseTimer = setInterval(() => {
        void this.api.renewAimvComposeLease(job).catch((error) => {
          this.logger.warn(
            `[Lease] AIMV 合成续租失败 ${ctx()}: ${error instanceof Error ? error.message : error}`,
          );
        });
      }, Math.max(10_000, Math.floor(leaseSeconds * 500)));
    }

    const onProgress = async (p: ComposeProgressPayload) => {
      try {
        await this.api.updateProgress(job, p);
        if (p.stage !== lastStage) {
          lastStage = p.stage;
          this.logger.log(
            `[Progress] ${ctx()} ${p.percent}% stage=${p.stage} — ${p.message}`,
          );
        }
      } catch (err) {
        this.logger.warn(`[Progress] 上报失败 ${ctx()}: ${err instanceof Error ? err.message : err}`);
      }
    };

    this.logger.log(`[Start] ${ctx()} priority=${job.priority}`);

    try {
      let outputs: JobCompleteOutputs;
      switch (job.type) {
        case 'compose_final':
          outputs = await this.composeHandler.run(job, onProgress);
          break;
        case 'recompose_subtitle':
          outputs = await this.subtitleHandler.run(job, onProgress);
          break;
        case 'render_editor':
          outputs = await this.editorHandler.run(job, onProgress);
          break;
        case 'editor_thumbnails':
          outputs = await this.thumbnailsHandler.run(job, onProgress);
          break;
        case 'prepare_karaoke_audio':
          outputs = await this.prepareKaraokeAudioHandler.run(job, onProgress);
          break;
        case 'extract_karaoke_frame':
          outputs = await this.extractKaraokeFrameHandler.run(job, onProgress);
          break;
        case 'compose_karaoke':
        case 'compose_aimv':
          outputs = await this.composeKaraokeHandler.run(job, onProgress);
          break;
        default:
          throw new Error(`未知 job type: ${(job as WorkerJobDto).type}`);
      }
      if (job.type === 'compose_aimv') await this.api.completeAimvComposition(job, outputs);
      else await this.api.complete(job, outputs);
      this.logger.log(`[Done] ${ctx()} result=${outputs.resultUrl?.slice(0, 80) ?? 'n/a'}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[Failed] ${ctx()} error=${msg.slice(0, 200)}`);
      if (job.type === 'compose_aimv') {
        await this.api.failAimvComposition(job, msg).catch((error) => {
          this.logger.warn(`[Failed] AIMV 项目失败回调未接受 ${ctx()}: ${error instanceof Error ? error.message : error}`);
        });
      } else {
        await this.api.fail(job, msg, true).catch((error) => {
          this.logger.warn(`[Failed] 合成任务失败回调未接受 ${ctx()}: ${error instanceof Error ? error.message : error}`);
        });
      }
    } finally {
      if (leaseTimer) clearInterval(leaseTimer);
    }
  }
}
