import * as fs from 'fs';
import * as path from 'path';
import type { WatermarkConfigPayload } from '../contracts/worker-job.contract';
import type { FfmpegRunner } from './ffmpeg-runner';
import type { DownloaderService } from '../storage/storage.service';

export async function burnSubtitleOntoVideo(
  runner: FfmpegRunner,
  inputPath: string,
  assContent: string,
  outputPath: string,
  workDir: string,
): Promise<boolean> {
  if (!assContent.includes('Dialogue:')) return false;
  const assPath = path.join(workDir, 'lyrics.ass');
  fs.writeFileSync(assPath, assContent, 'utf8');
  const safeAssPath = assPath.replace(/\\/g, '/').replace(/'/g, "'\\''").replace(/:/g, '\\:');
  const vf = `subtitles=filename='${safeAssPath}'`;
  try {
    await runner.exec([
      '-y', '-i', inputPath,
      '-vf', vf,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
      '-c:a', 'copy', '-movflags', '+faststart',
      outputPath,
    ]);
    return fs.existsSync(outputPath);
  } catch {
    return false;
  }
}

export async function applyWatermarkPass(
  runner: FfmpegRunner,
  downloader: DownloaderService,
  inputPath: string,
  outputPath: string,
  config: WatermarkConfigPayload,
  tmpDir: string,
): Promise<boolean> {
  if (!config.enabled || !config.imageUrl?.trim()) return false;
  const wmLocal = path.join(tmpDir, `watermark_${Date.now()}.png`);
  try {
    await downloader.download(config.imageUrl, wmLocal, 60_000);
    const scale = Math.min(1, Math.max(0.05, config.scale ?? 0.15));
    const opacity = Math.min(1, Math.max(0, config.opacity ?? 0.8));
    const { x, y } = watermarkOverlayPosition(config);
    const filter =
      `[1:v][0:v]scale2ref=w=ref_w*${scale}:h=-1:force_original_aspect_ratio=decrease[wm][base];` +
      `[wm]format=rgba,colorchannelmixer=aa=${opacity}[wma];` +
      `[base][wma]overlay=${x}:${y}[vout]`;
    await runner.exec([
      '-y', '-i', inputPath, '-loop', '1', '-i', wmLocal,
      '-filter_complex', filter,
      '-map', '[vout]', '-map', '0:a?',
      '-shortest', '-c:v', 'libx264', '-crf', '18', '-preset', 'fast',
      '-c:a', 'copy', '-movflags', '+faststart',
      outputPath,
    ]);
    return fs.existsSync(outputPath);
  } catch {
    return false;
  } finally {
    try { if (fs.existsSync(wmLocal)) fs.unlinkSync(wmLocal); } catch { /* ignore */ }
  }
}

function watermarkOverlayPosition(config: WatermarkConfigPayload): { x: string; y: string } {
  const mx = Math.round(config.marginX ?? 16);
  const my = Math.round(config.marginY ?? 16);
  switch (config.position) {
    case 'top-left': return { x: `${mx}`, y: `${my}` };
    case 'top-right': return { x: `W-w-${mx}`, y: `${my}` };
    case 'bottom-left': return { x: `${mx}`, y: `H-h-${my}` };
    default: return { x: `W-w-${mx}`, y: `H-h-${my}` };
  }
}
