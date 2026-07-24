import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type {
  ComposeKaraokePayload,
  ComposeKaraokeSegmentPayload,
  ComposeProgressPayload,
  JobCompleteOutputs,
  WorkerJobDto,
} from '../contracts/worker-job.contract';
import { WORKER_CONFIG } from '../config/worker.constants';
import { DownloaderService, UploaderService } from '../storage/storage.service';
import { FfmpegRunner } from '../ffmpeg/ffmpeg-runner';
import { getCanvasSize } from '../ffmpeg/filters';
import { applyWatermarkPass } from '../ffmpeg/subtitle-burn';
import { LyricsV2RendererService } from '../rendering/lyrics-v2-renderer.service';

const MAX_HARD_CUT_FADE_SEC = 0; // 卡拉OK对口型片段禁止长转场，硬切以保证唱词同步

@Injectable()
export class ComposeKaraokeHandler {
  private readonly logger = new Logger(ComposeKaraokeHandler.name);
  private runner: FfmpegRunner;

  constructor(
    private readonly downloader: DownloaderService,
    private readonly uploader: UploaderService,
    private readonly lyricsV2: LyricsV2RendererService,
  ) {
    this.runner = new FfmpegRunner(WORKER_CONFIG.ffmpegPath, WORKER_CONFIG.ffprobePath);
  }

  async run(
    job: WorkerJobDto,
    onProgress: (p: ComposeProgressPayload) => Promise<void>,
  ): Promise<JobCompleteOutputs> {
    const payload = job.payload as ComposeKaraokePayload;
    const upload = job.upload;
    const workDir = path.join(
      WORKER_CONFIG.tmpDir || os.tmpdir(),
      `mv-worker-karaoke-${job.projectId}-${randomUUID()}`,
    );
    fs.mkdirSync(workDir, { recursive: true });

    try {
      await onProgress({ stage: 'preparing', percent: 2, message: '准备卡拉OK合成任务...' });

      const segments = [...payload.segments].sort((a, b) => a.segmentIndex - b.segmentIndex);
      const canvas = this.resolveCanvasSize(payload.aspectRatio, payload.resolution);

      const clipPaths: string[] = [];
      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        await onProgress({
          stage: 'downloading',
          percent: 5 + Math.round((i / Math.max(1, segments.length)) * 20),
          message: `下载片段 ${i + 1}/${segments.length}...`,
        });
        const clipPath = path.join(workDir, `seg_${String(i).padStart(3, '0')}.mp4`);
        await this.downloader.download(segment.videoUrl, clipPath);
        clipPaths.push(clipPath);
      }

      const musicPath = path.join(workDir, 'music.src');
      await this.downloader.download(payload.musicUrl, musicPath);
      await onProgress({ stage: 'downloading', percent: 28, message: '素材准备完成' });

      await onProgress({ stage: 'encoding', percent: 32, message: '标准化片段...' });
      const trimmedPaths = await this.normalizeSegments(clipPaths, segments, canvas, workDir, async (p) => {
        await onProgress({ stage: 'encoding', percent: 32 + Math.round(p * 0.35), message: '标准化片段...' });
      });

      await onProgress({ stage: 'encoding', percent: 68, message: '拼接片段...' });
      const concatPath = path.join(workDir, 'concat_output.mp4');
      await this.concatClips(trimmedPaths, concatPath, workDir);

      await onProgress({ stage: 'encoding', percent: 74, message: '混入原始音乐...' });
      const mixedPath = path.join(workDir, 'mixed.mp4');
      await this.mixMusic(concatPath, musicPath, mixedPath, payload.musicStartTime, payload.musicDuration);

      const cleanLocalPath = mixedPath;
      const actualDuration = await this.runner.probeDuration(cleanLocalPath, payload.musicDuration);

      let subtitleBurned = false;
      let resultPath = mixedPath;
      if (this.lyricsV2.supports(payload.subtitleConfig) && payload.lrcContent?.trim()) {
        const offsetLrc = this.offsetLrcContent(payload.lrcContent, payload.musicStartTime);
        const subbedPath = path.join(workDir, 'output_subbed.mp4');
        await onProgress({ stage: 'encoding', percent: 88, message: '渲染卡拉OK歌词...' });
        subtitleBurned = await this.lyricsV2.burn({
          runner: this.runner,
          inputPath: cleanLocalPath,
          outputPath: subbedPath,
          workDir,
          lrcContent: offsetLrc,
          durationSec: actualDuration,
          aspectRatio: payload.aspectRatio,
          config: payload.subtitleConfig!,
        });
        if (subtitleBurned) resultPath = subbedPath;
      }

      if (payload.watermarkConfig?.enabled && payload.watermarkConfig.imageUrl) {
        const wmPath = path.join(workDir, 'output_wm.mp4');
        await onProgress({ stage: 'encoding', percent: 95, message: '叠加水印...' });
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

  private resolveCanvasSize(
    aspectRatio: string,
    resolution: string,
  ): { width: number; height: number } {
    const base = getCanvasSize(aspectRatio);
    const res = (resolution || '').toLowerCase();
    let scale = 1;
    if (res.includes('2160') || res.includes('4k')) scale = 3;
    else if (res.includes('1080') || res.includes('fullhd') || res.includes('full-hd')) scale = 1.5;
    if (scale === 1) return base;
    return {
      width: Math.round((base.width * scale) / 2) * 2,
      height: Math.round((base.height * scale) / 2) * 2,
    };
  }

  private async normalizeSegments(
    clipPaths: string[],
    segments: ComposeKaraokeSegmentPayload[],
    canvas: { width: number; height: number },
    workDir: string,
    onProgress: (percent: number) => Promise<void>,
  ): Promise<string[]> {
    const trimDir = path.join(workDir, 'trimmed');
    fs.mkdirSync(trimDir, { recursive: true });
    const scaleFilter =
      `scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=increase,` +
      `crop=${canvas.width}:${canvas.height},fps=25`;

    const trimmedPaths: string[] = [];
    for (let i = 0; i < clipPaths.length; i++) {
      const segment = segments[i];
      const trimmedPath = path.join(trimDir, `trimmed_${String(i).padStart(3, '0')}.mp4`);

      const actualClipDuration = await this.runner.probeDuration(clipPaths[i], 0);
      const plannedDuration = segment.plannedDuration;
      // 硬切到 plannedDuration，去掉 Provider 多余尾部；若素材更短则以素材实际时长为准
      const effectiveDuration = plannedDuration > 0 && actualClipDuration > 0
        ? Math.min(plannedDuration, actualClipDuration)
        : (plannedDuration > 0 ? plannedDuration : actualClipDuration);

      const vfChain = MAX_HARD_CUT_FADE_SEC > 0
        ? `${scaleFilter},fade=t=out:st=${Math.max(0, effectiveDuration - MAX_HARD_CUT_FADE_SEC).toFixed(3)}:d=${MAX_HARD_CUT_FADE_SEC}`
        : scaleFilter;

      await this.runner.exec([
        '-y', '-i', clipPaths[i],
        '-t', String(effectiveDuration > 0 ? effectiveDuration : plannedDuration || 1),
        '-vf', vfChain,
        '-an',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
        trimmedPath,
      ]);
      trimmedPaths.push(trimmedPath);
      await onProgress(Math.round(((i + 1) / clipPaths.length) * 100));
    }
    return trimmedPaths;
  }

  private async concatClips(trimmedPaths: string[], concatOutputPath: string, workDir: string): Promise<void> {
    if (trimmedPaths.length === 1) {
      fs.copyFileSync(trimmedPaths[0], concatOutputPath);
      return;
    }
    const concatListPath = path.join(workDir, 'concat.txt');
    fs.writeFileSync(
      concatListPath,
      trimmedPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'),
    );
    await this.runner.exec(['-y', '-f', 'concat', '-safe', '0', '-i', concatListPath, '-c', 'copy', concatOutputPath]);
  }

  private async mixMusic(
    videoPath: string,
    musicPath: string,
    outputPath: string,
    musicStartTime: number,
    musicDuration: number,
  ): Promise<void> {
    const audioSeekArgs = musicStartTime > 0 ? ['-ss', String(musicStartTime)] : [];
    const videoDuration = await this.runner.probeDuration(videoPath, musicDuration);
    // 保证最终时长与制作区间误差 <150ms：以较短者为准，避免拼接后视频比音乐长/短过多
    const effectiveDuration = videoDuration > 0 ? Math.min(videoDuration, musicDuration) : musicDuration;

    await this.runner.spawnFfmpeg(
      [
        '-y', '-i', videoPath, ...audioSeekArgs, '-i', musicPath,
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
        '-c:a', 'aac', '-b:a', '320k',
        '-t', String(effectiveDuration),
        '-map', '0:v:0', '-map', '1:a:0', '-movflags', '+faststart',
        outputPath,
      ],
      effectiveDuration,
    );
  }

  /** LRC 时间戳基于完整歌曲；合成视频从 musicStartTime 开始，需整体减去该偏移。 */
  private offsetLrcContent(lrcContent: string, offsetSec: number): string {
    if (offsetSec <= 0) return lrcContent;
    return lrcContent
      .split('\n')
      .map((line) => {
        return line.replace(/\[(\d+):(\d+(?:\.\d+)?)\]/g, (_match, mm: string, ss: string) => {
          const totalSec = Number(mm) * 60 + Number(ss) - offsetSec;
          const clamped = Math.max(0, totalSec);
          const outMin = Math.floor(clamped / 60);
          const outSec = clamped - outMin * 60;
          return `[${String(outMin).padStart(2, '0')}:${outSec.toFixed(2).padStart(5, '0')}]`;
        });
      })
      .join('\n');
  }
}
