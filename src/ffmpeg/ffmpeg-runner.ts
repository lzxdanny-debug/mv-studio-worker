import { spawn } from 'child_process';
import { promisify } from 'util';
import { execFile } from 'child_process';

const execFileAsync = promisify(execFile);

export type ProgressCallback = (percent: number, message: string) => void;

export class FfmpegRunner {
  constructor(
    private readonly ffmpegBin: string,
    private readonly ffprobeBin: string,
  ) {}

  async probeDuration(filePath: string, fallback = 30): Promise<number> {
    try {
      const r = await execFileAsync(this.ffprobeBin, [
        '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        filePath,
      ]);
      const d = parseFloat(r.stdout.trim());
      return Number.isFinite(d) && d > 0 ? d : fallback;
    } catch {
      return fallback;
    }
  }

  async exec(args: string[], maxBuffer = 32 * 1024 * 1024): Promise<void> {
    await execFileAsync(this.ffmpegBin, args, { maxBuffer });
  }

  spawnFfmpeg(
    args: string[],
    totalSeconds: number,
    onProgress?: (percent: number) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.ffmpegBin, args);
      let stderrBuf = '';
      proc.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stderrBuf += text;
        if (totalSeconds > 0 && onProgress) {
          const match = text.match(/time=(\d+):(\d+):(\d+\.?\d*)/);
          if (match) {
            const secs = parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseFloat(match[3]);
            onProgress(Math.min(99, Math.round((secs / totalSeconds) * 100)));
          }
        }
      });
      proc.on('close', (code) => {
        if (code === 0) {
          onProgress?.(100);
          resolve();
        } else {
          reject(new Error(`FFmpeg 退出 code=${code}: ${stderrBuf.slice(-400)}`));
        }
      });
      proc.on('error', reject);
    });
  }
}
