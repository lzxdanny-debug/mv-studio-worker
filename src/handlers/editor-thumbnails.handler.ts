import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type {
  ComposeProgressPayload,
  EditorThumbnailsPayload,
  JobCompleteOutputs,
  WorkerJobDto,
} from '../contracts/worker-job.contract';
import { WORKER_CONFIG } from '../config/worker.constants';
import { DownloaderService, UploaderService } from '../storage/storage.service';
import { FfmpegRunner } from '../ffmpeg/ffmpeg-runner';

@Injectable()
export class EditorThumbnailsHandler {
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
    const payload = job.payload as EditorThumbnailsPayload;
    const upload = job.upload;
    const extraUploads = upload.extraUploads ?? [];
    const workDir = path.join(os.tmpdir(), `mv-worker-th-${job.projectId}-${randomUUID()}`);
    fs.mkdirSync(workDir, { recursive: true });

    const shotResults: Array<{ shotId: string; editorFrameUrls: string[]; editorFrameSourceUrl: string }> = [];
    let firstPublicUrl = upload.resultPublicUrl;

    try {
      const shotsToProcess = payload.shots.filter((s) => {
        if (payload.force) return true;
        if (s.existingFrameUrls?.length && s.existingSourceUrl === s.sourceUrl) return false;
        return true;
      });

      for (let i = 0; i < shotsToProcess.length; i++) {
        const shot = shotsToProcess[i];
        await onProgress({
          stage: 'encoding',
          percent: 10 + Math.round((i / shotsToProcess.length) * 80),
          message: `抽帧 shot ${shot.shotIndex + 1}...`,
        });

        const shotDir = path.join(workDir, `shot_${shot.shotIndex}`);
        fs.mkdirSync(shotDir, { recursive: true });
        const clipPath = path.join(shotDir, 'source.mp4');
        await this.downloader.download(shot.sourceUrl, clipPath);

        const framePattern = path.join(shotDir, 'frame_%03d.jpg');
        await this.runner.exec([
          '-y', '-i', clipPath,
          '-vf', 'fps=1,scale=320:-2:force_original_aspect_ratio=decrease',
          '-frames:v', '8', '-q:v', '3',
          framePattern,
        ]);

        const frameFiles = fs.readdirSync(shotDir)
          .filter((n) => /^frame_\d+\.jpg$/i.test(n))
          .sort();
        const frameUrls: string[] = [];

        for (let fi = 0; fi < frameFiles.length; fi++) {
          const key = `shot_${shot.shotIndex}_frame_${fi}`;
          const target = extraUploads.find((u) => u.key === key);
          if (!target) continue;
          const localPath = path.join(shotDir, frameFiles[fi]);
          await this.uploader.uploadPresigned(localPath, target.putUrl, target.contentType);
          frameUrls.push(target.publicUrl);
          if (!firstPublicUrl) firstPublicUrl = target.publicUrl;
        }

        if (frameUrls.length > 0) {
          shotResults.push({
            shotId: shot.shotId,
            editorFrameUrls: frameUrls,
            editorFrameSourceUrl: shot.sourceUrl,
          });
        }
      }

      return {
        resultUrl: firstPublicUrl,
        shots: shotResults,
      };
    } finally {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}
