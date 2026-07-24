import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type {
  ComposeProgressPayload,
  ExtractKaraokeFramePayload,
  JobCompleteOutputs,
  WorkerJobDto,
} from '../contracts/worker-job.contract';
import { WORKER_CONFIG } from '../config/worker.constants';
import { DownloaderService, UploaderService } from '../storage/storage.service';
import { FfmpegRunner } from '../ffmpeg/ffmpeg-runner';

const execFileAsync = promisify(execFile);

const DEFAULT_CANDIDATE_OFFSETS_SEC = [0.35, 0.2, 0.1];
const DARK_LUMA_THRESHOLD = 24;
const BRIGHT_LUMA_THRESHOLD = 232;

interface CandidateEvaluation {
  offsetSec: number;
  timestampSec: number;
  luma: number;
  stabilityScore: number;
  isValid: boolean;
  framePath: string;
}

@Injectable()
export class ExtractKaraokeFrameHandler {
  private readonly logger = new Logger(ExtractKaraokeFrameHandler.name);
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
    const payload = job.payload as ExtractKaraokeFramePayload;
    const upload = job.upload;
    const workDir = path.join(
      WORKER_CONFIG.tmpDir || os.tmpdir(),
      `mv-worker-kframe-${job.projectId}-${randomUUID()}`,
    );
    fs.mkdirSync(workDir, { recursive: true });

    try {
      await onProgress({ stage: 'downloading', percent: 10, message: '下载视频片段...' });
      const videoPath = path.join(workDir, 'source.mp4');
      await this.downloader.download(payload.videoUrl, videoPath);

      const probedDuration = await this.runner.probeDuration(videoPath, payload.plannedDurationSec);
      // Provider 返回的实际片长可能比计划值短（例如计划 5.4s，实际只有 5.0s）。
      // 使用计划值会把 -ss 定位到文件末尾之外，得到空帧并触发错误的连续性降级。
      const effectiveDuration =
        probedDuration > 0 && payload.plannedDurationSec > 0
          ? Math.min(probedDuration, payload.plannedDurationSec)
          : Math.max(probedDuration, payload.plannedDurationSec);
      const offsets = payload.candidateOffsetsFromEndSec?.length
        ? payload.candidateOffsetsFromEndSec
        : DEFAULT_CANDIDATE_OFFSETS_SEC;

      await onProgress({ stage: 'encoding', percent: 30, message: '评估候选帧...' });

      const evaluations: CandidateEvaluation[] = [];
      for (let i = 0; i < offsets.length; i++) {
        const offsetSec = offsets[i];
        const timestampSec = Math.max(
          0,
          Math.min(effectiveDuration - 0.05, effectiveDuration - offsetSec),
        );
        const evaluation = await this.evaluateCandidate(videoPath, workDir, i, offsetSec, timestampSec);
        evaluations.push(evaluation);
      }

      const best = this.pickBest(evaluations);

      await onProgress({ stage: 'uploading', percent: 90, message: '上传候选帧...' });
      await this.uploader.uploadPresigned(best.framePath, upload.resultPutUrl, upload.contentType);

      for (const evaluation of evaluations) {
        try { fs.unlinkSync(evaluation.framePath); } catch { /* ignore */ }
      }

      return {
        resultUrl: upload.resultPublicUrl,
        extra: {
          selectedOffsetSec: best.offsetSec,
          luma: best.luma,
          stabilityScore: best.stabilityScore,
        },
      };
    } finally {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  private async evaluateCandidate(
    videoPath: string,
    workDir: string,
    index: number,
    offsetSec: number,
    timestampSec: number,
  ): Promise<CandidateEvaluation> {
    const framePath = path.join(workDir, `candidate_${index}.jpg`);
    await this.runner.exec([
      '-y', '-ss', String(timestampSec), '-i', videoPath,
      '-frames:v', '1', '-q:v', '2', framePath,
    ]);

    const { luma, stabilityScore } = await this.measureLumaAndStability(videoPath, timestampSec);
    const isValid = luma >= DARK_LUMA_THRESHOLD && luma <= BRIGHT_LUMA_THRESHOLD;

    return { offsetSec, timestampSec, luma, stabilityScore, isValid, framePath };
  }

  /** 用 signalstats 近似估计画面亮度（YAVG）与帧间稳定度（1 / (1 + 平均 YDIF)）。 */
  private async measureLumaAndStability(
    videoPath: string,
    timestampSec: number,
  ): Promise<{ luma: number; stabilityScore: number }> {
    const probeStart = Math.max(0, timestampSec - 0.15);
    try {
      const { stdout, stderr } = await execFileAsync(WORKER_CONFIG.ffmpegPath, [
        '-ss', String(probeStart), '-i', videoPath,
        '-t', '0.3', '-vf', 'fps=15,signalstats,metadata=print',
        '-f', 'null', '-',
      ], { maxBuffer: 16 * 1024 * 1024 });

      const text = `${stdout}\n${stderr}`;
      const yavgValues = [...text.matchAll(/YAVG=([\d.]+)/g)].map((m) => parseFloat(m[1]));
      const ydifValues = [...text.matchAll(/YDIF=([\d.]+)/g)].map((m) => parseFloat(m[1]));

      const luma = yavgValues.length
        ? yavgValues[yavgValues.length - 1]
        : 128;
      const avgMotion = ydifValues.length
        ? ydifValues.reduce((a, b) => a + b, 0) / ydifValues.length
        : 0;
      const stabilityScore = Math.max(0, Math.min(1, 1 / (1 + avgMotion)));

      return { luma, stabilityScore };
    } catch (err) {
      this.logger.warn(`亮度/稳定度评估失败 @${timestampSec.toFixed(2)}s: ${err instanceof Error ? err.message : err}`);
      return { luma: 128, stabilityScore: 0.5 };
    }
  }

  private pickBest(evaluations: CandidateEvaluation[]): CandidateEvaluation {
    const valid = evaluations.filter((e) => e.isValid);
    const pool = valid.length > 0 ? valid : evaluations;
    return pool.reduce((best, curr) => {
      const bestScore = best.stabilityScore - Math.abs(best.luma - 128) / 255;
      const currScore = curr.stabilityScore - Math.abs(curr.luma - 128) / 255;
      return currScore > bestScore ? curr : best;
    }, pool[0]);
  }
}
