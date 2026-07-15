import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import type { SubtitleConfigPayload } from '../contracts/worker-job.contract';
import type { FfmpegRunner } from '../ffmpeg/ffmpeg-runner';

@Injectable()
export class LyricsV2RendererService {
  private readonly logger = new Logger(LyricsV2RendererService.name);
  private bundlePromise?: Promise<string>;

  supports(config?: SubtitleConfigPayload | null): boolean {
    return config?.enabled !== false && config?.renderer === 'remotion' && config?.version === 2;
  }

  private getBundle(): Promise<string> {
    if (!this.bundlePromise) {
      const developmentEntry = path.resolve(process.cwd(), 'src/remotion/index.tsx');
      const runtimeEntry = path.resolve(process.cwd(), 'remotion/index.tsx');
      const entryPoint = fs.existsSync(developmentEntry) ? developmentEntry : runtimeEntry;
      this.bundlePromise = bundle({ entryPoint, onProgress: () => undefined });
    }
    return this.bundlePromise;
  }

  async burn(params: {
    runner: FfmpegRunner; inputPath: string; outputPath: string; workDir: string;
    lrcContent: string; durationSec: number; aspectRatio: string; config: SubtitleConfigPayload;
  }): Promise<boolean> {
    if (!params.lrcContent.trim()) return false;
    const portrait = params.aspectRatio === '9:16';
    const width = portrait ? 720 : 1280; const height = portrait ? 1280 : 720;
    const inputProps = { lrcContent: params.lrcContent, durationSec: params.durationSec, width, height, config: params.config };
    const serveUrl = await this.getBundle();
    const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
    const composition = await selectComposition({ serveUrl, id: 'LyricsOverlay', inputProps, browserExecutable });
    const overlayPath = path.join(params.workDir, 'lyrics-overlay.mov');
    this.logger.log(`Rendering Lyrics V2 preset=${params.config.lyricsV2Preset ?? 'mozi'}`);
    await renderMedia({
      composition, serveUrl, inputProps, outputLocation: overlayPath,
      codec: 'prores', proResProfile: '4444', pixelFormat: 'yuva444p10le',
      imageFormat: 'png',
      browserExecutable,
    });
    await params.runner.exec([
      '-y', '-i', params.inputPath, '-i', overlayPath,
      '-filter_complex', '[0:v][1:v]overlay=0:0:format=auto[v]',
      '-map', '[v]', '-map', '0:a?', '-c:v', 'libx264', '-crf', '18', '-preset', 'fast',
      '-c:a', 'copy', '-movflags', '+faststart', params.outputPath,
    ]);
    return fs.existsSync(params.outputPath);
  }
}
