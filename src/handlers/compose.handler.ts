import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type {
  ComposeFinalPayload,
  ComposeProgressPayload,
  JobCompleteOutputs,
  UploadTargets,
  WorkerJobDto,
} from '../contracts/worker-job.contract';
import { WORKER_CONFIG } from '../config/worker.constants';
import { ClipCacheService } from '../storage/clip-cache.service';
import { DownloaderService, UploaderService } from '../storage/storage.service';
import { FfmpegRunner } from '../ffmpeg/ffmpeg-runner';
import { runFfmpegCompose } from '../ffmpeg/compose-pipeline';
import { getColorGradeFilter, truncateAssByDuration } from '../ffmpeg/filters';
import { applyWatermarkPass, burnSubtitleOntoVideo } from '../ffmpeg/subtitle-burn';
import { LyricsV2RendererService } from '../rendering/lyrics-v2-renderer.service';

@Injectable()
export class ComposeHandler {
  private readonly logger = new Logger(ComposeHandler.name);
  private runner: FfmpegRunner;

  constructor(
    private readonly downloader: DownloaderService,
    private readonly uploader: UploaderService,
    private readonly clipCache: ClipCacheService,
    private readonly lyricsV2: LyricsV2RendererService,
  ) {
    this.runner = new FfmpegRunner(WORKER_CONFIG.ffmpegPath, WORKER_CONFIG.ffprobePath);
  }

  async run(
    job: WorkerJobDto,
    onProgress: (p: ComposeProgressPayload) => Promise<void>,
  ): Promise<JobCompleteOutputs> {
    const payload = job.payload as ComposeFinalPayload;
    const upload = job.upload;
    const workDir = path.join(
      WORKER_CONFIG.tmpDir || os.tmpdir(),
      `mv-worker-${job.projectId}-${randomUUID()}`,
    );
    fs.mkdirSync(workDir, { recursive: true });

    try {
      await onProgress({ stage: 'preparing', percent: 2, message: '准备合成任务...' });

      const clipPaths: string[] = [];
      for (let i = 0; i < payload.shots.length; i++) {
        const shot = payload.shots[i];
        await onProgress({
          stage: 'downloading',
          percent: 5 + Math.round((i / payload.shots.length) * 20),
          message: `准备片段 ${i + 1}/${payload.shots.length}...`,
        });
        const clipPath = await this.clipCache.ensureClip(
          job.projectId,
          shot.shotIndex,
          shot.videoUrl,
          shot.updatedAt,
        );
        clipPaths.push(clipPath);
      }

      const audioPath = await this.clipCache.ensureMusic(job.projectId, payload.musicUrl);
      await onProgress({ stage: 'downloading', percent: 28, message: '素材准备完成' });

      let effectiveAudioStart = payload.musicStartTime ?? 0;
      if (payload.audioOffsetCalibrationEnabled && payload.audioOffsetMs) {
        const candidate = effectiveAudioStart - payload.audioOffsetMs / 1000;
        if (candidate >= 0) effectiveAudioStart = candidate;
      }

      const outputPath = path.join(workDir, 'output.mp4');
      await onProgress({ stage: 'encoding', percent: 32, message: '开始 FFmpeg 合成...' });
      await runFfmpegCompose(
        this.runner,
        clipPaths,
        payload.shots,
        audioPath,
        outputPath,
        payload.musicDuration,
        effectiveAudioStart,
        payload.aspectRatio,
        async (percent, message) => {
          await onProgress({ stage: 'encoding', percent: 32 + Math.round(percent * 0.55), message });
        },
      );

      let finalOutputPath = outputPath;
      const colorGradeFilter = getColorGradeFilter(payload.styleTag ?? '');
      if (colorGradeFilter) {
        const gradedPath = path.join(workDir, 'output_graded.mp4');
        await onProgress({ stage: 'encoding', percent: 90, message: '应用视觉调色...' });
        try {
          await this.runner.exec([
            '-y', '-i', outputPath, '-vf', colorGradeFilter,
            '-c:v', 'libx264', '-crf', '18', '-preset', 'fast', '-c:a', 'copy',
            gradedPath,
          ]);
          finalOutputPath = gradedPath;
        } catch {
          finalOutputPath = outputPath;
        }
      }

      const cleanLocalPath = finalOutputPath;
      const actualDuration = await this.runner.probeDuration(cleanLocalPath, payload.musicDuration);
      let subtitleBurned = false;
      let resultPath = finalOutputPath;

      if (this.lyricsV2.supports(payload.subtitleConfig) && payload.lrcContent?.trim()) {
        const subbedPath = path.join(workDir, 'output_subbed.mp4');
        await onProgress({ stage: 'encoding', percent: 94, message: '渲染动态歌词...' });
        subtitleBurned = await this.lyricsV2.burn({
          runner: this.runner,
          inputPath: cleanLocalPath,
          outputPath: subbedPath,
          workDir,
          lrcContent: payload.lrcContent,
          durationSec: actualDuration,
          aspectRatio: payload.aspectRatio,
          config: payload.subtitleConfig!,
        });
        if (subtitleBurned) resultPath = subbedPath;
      } else if (payload.assContent?.trim() && payload.subtitleConfig?.enabled !== false) {
        const ass = truncateAssByDuration(payload.assContent, actualDuration);
        const subbedPath = path.join(workDir, 'output_subbed.mp4');
        await onProgress({ stage: 'encoding', percent: 94, message: '烧录字幕...' });
        subtitleBurned = await burnSubtitleOntoVideo(
          this.runner, cleanLocalPath, ass, subbedPath, workDir,
        );
        if (subtitleBurned) resultPath = subbedPath;
      }

      if (payload.watermarkConfig?.enabled && payload.watermarkConfig.imageUrl) {
        const wmPath = path.join(workDir, 'output_wm.mp4');
        await onProgress({ stage: 'encoding', percent: 96, message: '叠加水印...' });
        const ok = await applyWatermarkPass(
          this.runner, this.downloader, resultPath, wmPath, payload.watermarkConfig, workDir,
        );
        if (ok) resultPath = wmPath;
      }

      await onProgress({ stage: 'uploading', percent: 98, message: '上传成片...' });
      await this.uploader.uploadPresigned(resultPath, upload.resultPutUrl, upload.contentType);

      let subtitleBaseUrl: string | undefined;
      if (subtitleBurned && upload.cleanPutUrl && upload.cleanPublicUrl) {
        await this.uploader.uploadPresigned(cleanLocalPath, upload.cleanPutUrl, upload.contentType);
        subtitleBaseUrl = upload.cleanPublicUrl;
      }

      return {
        resultUrl: upload.resultPublicUrl,
        subtitleBaseUrl,
        actualDurationSec: actualDuration,
      };
    } finally {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}
