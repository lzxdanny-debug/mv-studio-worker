import * as fs from 'fs';
import * as path from 'path';
import type { ComposeShotPayload } from '../contracts/worker-job.contract';
import type { FfmpegRunner, ProgressCallback } from './ffmpeg-runner';
import { getCanvasSize } from './filters';

export async function runFfmpegCompose(
  runner: FfmpegRunner,
  clipPaths: string[],
  shots: ComposeShotPayload[],
  audioPath: string,
  outputPath: string,
  totalDuration: number,
  audioStartTime: number,
  aspectRatio: string,
  onProgress?: ProgressCallback,
): Promise<void> {
  const canvas = getCanvasSize(aspectRatio);
  const audioSeekArgs = audioStartTime > 0 ? ['-ss', String(audioStartTime)] : [];

  if (clipPaths.length === 1) {
    let singleDuration = await runner.probeDuration(clipPaths[0], 0);
    const effectiveDuration = singleDuration > 0
      ? Math.min(singleDuration, totalDuration)
      : totalDuration;
    onProgress?.(5, '混入音轨...');
    await runner.spawnFfmpeg(
      [
        '-y', '-i', clipPaths[0], ...audioSeekArgs, '-i', audioPath,
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
        '-c:a', 'aac', '-b:a', '320k',
        '-t', String(effectiveDuration),
        '-map', '0:v:0', '-map', '1:a:0', '-movflags', '+faststart',
        outputPath,
      ],
      effectiveDuration,
      (p) => onProgress?.(5 + Math.round(p * 0.93), `混入音轨 ${p}%`),
    );
    onProgress?.(100, '完成');
    return;
  }

  const trimDir = path.join(path.dirname(outputPath), 'trimmed');
  fs.mkdirSync(trimDir, { recursive: true });

  const extractSceneIdx = (sid?: string): number | null => {
    if (!sid) return null;
    const m = String(sid).match(/scene[_-]?(\d+)/i);
    return m ? Number(m[1]) : null;
  };
  const computeBoundary = (prev: ComposeShotPayload, curr: ComposeShotPayload) => {
    if (prev.sceneId && curr.sceneId && prev.sceneId === curr.sceneId) {
      return { fadeOutDur: 0, fadeInDur: 0 };
    }
    const prevIdx = extractSceneIdx(prev.sceneId);
    const currIdx = extractSceneIdx(curr.sceneId);
    if (prevIdx !== null && currIdx !== null && Math.abs(currIdx - prevIdx) >= 2) {
      return { fadeOutDur: 0.4, fadeInDur: 0.4 };
    }
    return { fadeOutDur: 0.2, fadeInDur: 0.2 };
  };

  const trimmedPaths: string[] = [];
  for (let i = 0; i < clipPaths.length; i++) {
    const shot = shots[i];
    const plannedDuration = shot.duration;
    const trimmedPath = path.join(trimDir, `trimmed_${String(i).padStart(3, '0')}.mp4`);
    fs.mkdirSync(trimDir, { recursive: true });

    if (plannedDuration && plannedDuration > 0) {
      const actualClipDuration = await runner.probeDuration(clipPaths[i], 0);
      const clipShortBy = actualClipDuration > 0 && actualClipDuration < plannedDuration - 0.1
        ? plannedDuration - actualClipDuration
        : 0;
      const effectiveDuration = clipShortBy > 0 ? actualClipDuration : plannedDuration;

      const inFade = i > 0 ? computeBoundary(shots[i - 1], shot).fadeInDur : 0;
      const outFade = i < shots.length - 1 ? computeBoundary(shot, shots[i + 1]).fadeOutDur : 0;
      const clampedInFade = inFade > 0 ? Math.min(inFade, effectiveDuration * 0.3) : 0;
      const clampedOutFade = outFade > 0 ? Math.min(outFade, effectiveDuration * 0.3) : 0;
      const fadeFilters: string[] = [];
      if (clampedInFade > 0) fadeFilters.push(`fade=t=in:st=0:d=${clampedInFade.toFixed(3)}`);
      if (clampedOutFade > 0 && effectiveDuration > clampedOutFade * 2) {
        fadeFilters.push(`fade=t=out:st=${(effectiveDuration - clampedOutFade).toFixed(3)}:d=${clampedOutFade.toFixed(3)}`);
      }
      const scaleFilter =
        `scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=increase,` +
        `crop=${canvas.width}:${canvas.height},fps=24`;
      const vfChain = [scaleFilter, ...fadeFilters].join(',');
      const trimPct = Math.round((i / clipPaths.length) * 55);
      onProgress?.(trimPct, `剪辑片段 ${i + 1}/${clipPaths.length}...`);
      await runner.spawnFfmpeg(
        ['-y', '-i', clipPaths[i], '-t', String(effectiveDuration), '-vf', vfChain,
          '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-an', trimmedPath],
        effectiveDuration,
      );
    } else {
      fs.copyFileSync(clipPaths[i], trimmedPath);
    }
    trimmedPaths.push(trimmedPath);
  }

  onProgress?.(57, '合并片段...');
  const concatOutputPath = path.join(path.dirname(outputPath), 'concat_output.mp4');
  const concatListPath = path.join(path.dirname(outputPath), 'concat.txt');
  fs.writeFileSync(
    concatListPath,
    trimmedPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'),
  );
  await runner.exec(['-y', '-f', 'concat', '-safe', '0', '-i', concatListPath, '-c', 'copy', concatOutputPath]);

  const concatDuration = await runner.probeDuration(concatOutputPath, 0);
  const effectiveDuration = concatDuration > 0
    ? Math.min(concatDuration, totalDuration)
    : totalDuration;

  onProgress?.(67, '混入音轨...');
  await runner.spawnFfmpeg(
    [
      '-y', '-i', concatOutputPath, ...audioSeekArgs, '-i', audioPath,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
      '-c:a', 'aac', '-b:a', '320k',
      '-t', String(effectiveDuration),
      '-map', '0:v:0', '-map', '1:a:0', '-movflags', '+faststart',
      outputPath,
    ],
    effectiveDuration,
    (p) => onProgress?.(67 + Math.round(p * 0.33), `混音编码 ${p}%`),
  );
  onProgress?.(100, '编码完成');
}
