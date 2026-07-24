import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type {
  ComposeProgressPayload,
  JobCompleteOutputs,
  PrepareKaraokeAudioPayload,
  WorkerJobDto,
} from '../contracts/worker-job.contract';
import { WORKER_CONFIG } from '../config/worker.constants';
import { DownloaderService, UploaderService } from '../storage/storage.service';
import { FfmpegRunner } from '../ffmpeg/ffmpeg-runner';

interface KaraokeAudioClipResult {
  segmentId: string;
  audioUrl: string;
  actualDurationSec: number;
}

@Injectable()
export class PrepareKaraokeAudioHandler {
  private readonly logger = new Logger(PrepareKaraokeAudioHandler.name);
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
    const payload = job.payload as PrepareKaraokeAudioPayload;
    const upload = job.upload;
    const extraUploads = upload.extraUploads ?? [];
    const workDir = path.join(
      WORKER_CONFIG.tmpDir || os.tmpdir(),
      `mv-worker-kaudio-${job.projectId}-${randomUUID()}`,
    );
    fs.mkdirSync(workDir, { recursive: true });

    try {
      await onProgress({ stage: 'downloading', percent: 5, message: '下载原始音乐...' });
      const musicPath = path.join(workDir, 'music.src');
      await this.downloader.download(payload.musicUrl, musicPath);

      const clips: KaraokeAudioClipResult[] = [];
      const segments = payload.segments ?? [];

      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        await onProgress({
          stage: 'encoding',
          percent: 10 + Math.round((i / Math.max(1, segments.length)) * 80),
          message: `切分音频片段 ${i + 1}/${segments.length}...`,
        });

        const leadInSec = (segment.leadInMs ?? 0) / 1000;
        const tailSec = (segment.tailMs ?? 0) / 1000;
        const rawStart = payload.musicStartTime + segment.startTime - leadInSec;
        const seekStart = Math.max(0, rawStart);
        // 若前导被裁边（起点已到 0），补偿到时长里避免片段变短
        const clampedLeadIn = rawStart < 0 ? leadInSec + rawStart : leadInSec;
        const clipDuration = segment.duration + Math.max(0, clampedLeadIn) + tailSec;

        const clipPath = path.join(workDir, `clip_${segment.segmentId}.mp3`);
        await this.runner.exec([
          '-y',
          '-ss', String(seekStart),
          '-i', musicPath,
          '-t', String(clipDuration),
          '-vn', '-c:a', 'libmp3lame', '-q:a', '2', '-ar', '44100',
          clipPath,
        ]);

        const actualDurationSec = await this.runner.probeDuration(clipPath, clipDuration);

        const target = extraUploads.find((u) => u.key === segment.segmentId);
        let audioUrl = '';
        if (target) {
          await this.uploader.uploadPresigned(clipPath, target.putUrl, target.contentType);
          audioUrl = target.publicUrl;
        } else {
          this.logger.warn(`未找到 segmentId=${segment.segmentId} 对应的 extraUploads 目标，跳过上传`);
        }

        clips.push({ segmentId: segment.segmentId, audioUrl, actualDurationSec });
        try { fs.unlinkSync(clipPath); } catch { /* ignore */ }
      }

      await onProgress({ stage: 'uploading', percent: 95, message: '音频片段处理完成' });

      const firstClipUrl = clips.find((c) => c.audioUrl)?.audioUrl || upload.resultPublicUrl;

      return {
        resultUrl: firstClipUrl,
        extra: { clips },
      };
    } finally {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}
