import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type {
  ComposeProgressPayload,
  JobCompleteOutputs,
  RenderEditorPayload,
  WorkerJobDto,
} from '../contracts/worker-job.contract';
import { WORKER_CONFIG } from '../config/worker.constants';
import { DownloaderService, UploaderService } from '../storage/storage.service';
import { FfmpegRunner } from '../ffmpeg/ffmpeg-runner';
import { buildEditorOverlayFilter, prepareEditorConfigForRender } from '../ffmpeg/editor-overlay';

@Injectable()
export class EditorHandler {
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
    const payload = job.payload as RenderEditorPayload;
    const upload = job.upload;
    const workDir = path.join(os.tmpdir(), `mv-worker-ed-${job.projectId}-${randomUUID()}`);
    fs.mkdirSync(workDir, { recursive: true });

    try {
      const overlays = payload.editorConfig.layers.filter(
        (l) => l.visible !== false && (l.type === 'text' || l.type === 'lyrics'),
      );
      const audioLayer = payload.editorConfig.layers.find(
        (l) => l.visible !== false && l.type === 'audio' && typeof l.sourceUrl === 'string',
      );
      const configuredAudioUrl = String(audioLayer?.sourceUrl || '').trim();
      const shouldReplaceAudio = !!configuredAudioUrl && configuredAudioUrl !== payload.musicUrl;
      const hasLyricsOverlay = overlays.some((l) => l.type === 'lyrics');
      const configuredSourceUrl = payload.editorConfig.layers.find(
        (l) => l.type === 'video' && typeof l.sourceUrl === 'string',
      )?.sourceUrl as string | undefined;
      const sourceUrl = hasLyricsOverlay && payload.subtitleBaseUrl
        ? payload.subtitleBaseUrl
        : (configuredSourceUrl || payload.sourceVideoUrl);

      await onProgress({ stage: 'downloading', percent: 15, message: '准备源视频...' });
      const sourcePath = path.join(workDir, 'source.mp4');
      await this.downloader.download(sourceUrl, sourcePath);

      const duration = await this.runner.probeDuration(sourcePath, 30);
      const renderConfig = prepareEditorConfigForRender(
        payload.lrcContent,
        payload.musicStartTime ?? 0,
        payload.editorConfig,
      );
      const filter = buildEditorOverlayFilter(renderConfig, workDir, duration);

      let audioPath: string | undefined;
      if (shouldReplaceAudio) {
        await onProgress({ stage: 'downloading', percent: 30, message: '准备替换音频...' });
        audioPath = path.join(workDir, 'audio-input');
        await this.downloader.download(configuredAudioUrl, audioPath);
      }

      const outputPath = path.join(workDir, 'output.mp4');
      await onProgress({ stage: 'encoding', percent: 50, message: '写入编辑内容...' });
      const ffmpegArgs = [
        '-y', '-i', sourcePath,
        ...(audioPath ? ['-i', audioPath] : []),
        '-map', '0:v:0',
        ...(audioPath ? ['-map', '1:a:0'] : ['-map', '0:a?']),
        ...(filter
          ? ['-vf', filter, '-c:v', 'libx264', '-crf', '18', '-preset', 'fast', '-pix_fmt', 'yuv420p']
          : ['-c:v', 'copy']),
        '-c:a', 'aac', '-b:a', '192k',
        '-movflags', '+faststart', '-shortest', '-f', 'mp4',
        outputPath,
      ];
      await this.runner.exec(ffmpegArgs);

      await onProgress({ stage: 'uploading', percent: 90, message: '上传成片...' });
      await this.uploader.uploadPresigned(outputPath, upload.resultPutUrl, upload.contentType);
      return {
        resultUrl: upload.resultPublicUrl,
        editorConfig: payload.editorConfig,
        actualDurationSec: duration,
      };
    } finally {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}
