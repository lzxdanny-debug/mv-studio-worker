import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type {
  ComposeProgressPayload,
  JobCompleteOutputs,
  RecomposeSubtitlePayload,
  WorkerJobDto,
} from '../contracts/worker-job.contract';
import { WORKER_CONFIG } from '../config/worker.constants';
import { DownloaderService, UploaderService } from '../storage/storage.service';
import { FfmpegRunner } from '../ffmpeg/ffmpeg-runner';
import { truncateAssByDuration } from '../ffmpeg/filters';
import { burnSubtitleOntoVideo } from '../ffmpeg/subtitle-burn';

@Injectable()
export class SubtitleHandler {
  private runner: FfmpegRunner;

  constructor(
    private readonly downloader: DownloaderService,
    private readonly uploader: UploaderService,
  ) {
    this.runner = new FfmpegRunner(WORKER_CONFIG.ffmpegPath, WORKER_CONFIG.ffprobePath);
  }

  async run(
    job: WorkerJobDto,
    onProgress: (p: ComposeProgressPayload) => Promise<void>,
  ): Promise<JobCompleteOutputs> {
    const payload = job.payload as RecomposeSubtitlePayload;
    const upload = job.upload;
    const workDir = path.join(os.tmpdir(), `mv-worker-sub-${job.projectId}-${randomUUID()}`);
    fs.mkdirSync(workDir, { recursive: true });

    try {
      await onProgress({ stage: 'downloading', percent: 10, message: '下载源视频...' });
      const sourcePath = path.join(workDir, 'source.mp4');
      await this.downloader.download(payload.sourceVideoUrl, sourcePath);

      const duration = await this.runner.probeDuration(sourcePath, 60);
      const assContent = payload.assContent?.trim();
      if (!assContent) throw new Error('payload 缺少 assContent，无法烧录字幕');

      const ass = truncateAssByDuration(assContent, duration);
      const outputPath = path.join(workDir, 'output.mp4');
      await onProgress({ stage: 'encoding', percent: 50, message: '烧录字幕...' });
      const ok = await burnSubtitleOntoVideo(this.runner, sourcePath, ass, outputPath, workDir);
      if (!ok) throw new Error('字幕烧录失败');

      await onProgress({ stage: 'uploading', percent: 90, message: '上传成片...' });
      await this.uploader.uploadPresigned(outputPath, upload.resultPutUrl, upload.contentType);
      return { resultUrl: upload.resultPublicUrl, actualDurationSec: duration };
    } finally {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}
