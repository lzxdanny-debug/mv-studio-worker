import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { EditorRenderLayerPayload } from '../contracts/worker-job.contract';

function isInstrumentalLrcText(text: string): boolean {
  return /^(纯音乐|instrumental|间奏|前奏|尾奏|\[.*\])$/i.test(text.trim());
}

export function parseEditorLrcLines(lrc?: string): Array<{ time: number; text: string }> {
  if (!lrc) return [];
  const rows: Array<{ time: number; text: string }> = [];
  const re = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g;
  for (const raw of lrc.split(/\r?\n/)) {
    const matches = Array.from(raw.matchAll(re));
    if (matches.length === 0) continue;
    const text = raw
      .replace(re, '')
      .replace(/<\d{1,2}:\d{2}(?:\.\d{1,3})?>/g, '')
      .replace(/\[(M|F|D)\]/gi, '')
      .trim();
    if (!text || isInstrumentalLrcText(text)) continue;
    for (const m of matches) {
      rows.push({
        time: Number(m[1]) * 60 + Number(m[2]) + Number(`0.${m[3] ?? '0'}`),
        text,
      });
    }
  }
  return rows.sort((a, b) => a.time - b.time);
}

export function shiftLrcContent(lrc: string, offsetSec: number): string {
  if (!offsetSec) return lrc;
  const re = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g;
  return lrc.replace(re, (_full, mm, ss, ms) => {
    const base = Number(mm) * 60 + Number(ss) + Number(`0.${ms ?? '0'}`);
    const shifted = Math.max(0, base + offsetSec);
    const m = Math.floor(shifted / 60);
    const s = shifted % 60;
    const whole = Math.floor(s);
    const frac = Math.round((s - whole) * 100);
    return `[${String(m).padStart(2, '0')}:${String(whole).padStart(2, '0')}.${String(frac).padStart(2, '0')}]`;
  });
}

export function prepareEditorConfigForRender(
  lrcContent: string | undefined,
  musicStartTime: number,
  config: { version: 1; layers: EditorRenderLayerPayload[] },
): { version: 1; layers: EditorRenderLayerPayload[] } {
  const projectLrc = lrcContent?.trim() || '';
  if (!projectLrc || musicStartTime <= 0) return config;
  return {
    ...config,
    layers: config.layers.map((layer) => {
      if (layer.type !== 'lyrics' || layer.lrcSource === 'editor') return layer;
      return {
        ...layer,
        lrcContent: shiftLrcContent(projectLrc, -musicStartTime),
        lrcTimebase: 'clip',
        lrcShiftedBy: musicStartTime,
      };
    }),
  };
}

export function buildEditorOverlayFilter(
  config: { layers: EditorRenderLayerPayload[] },
  workDir: string,
  videoDuration: number,
): string {
  const filters: string[] = [];
  const fontFile = findEditorFontFile();
  const sorted = [...config.layers]
    .filter((l) => l.visible !== false)
    .sort((a, b) => Number(a.zIndex ?? 0) - Number(b.zIndex ?? 0));

  for (const layer of sorted) {
    if (layer.type === 'text') {
      const text = String(layer.text ?? '').trim();
      if (!text) continue;
      const start = safeLayerTime(layer.startTime, 0, videoDuration);
      const end = safeLayerTime(Number(layer.startTime ?? 0) + Number(layer.duration ?? 4), videoDuration, videoDuration);
      if (end <= start) continue;
      const textFile = writeEditorTextFile(workDir, layer.id, text);
      const opacity = clamp01(Number(layer.opacity ?? 1));
      const fontSize = Math.max(12, Math.min(240, Number(layer.fontSize ?? 56)));
      const x = clamp01(Number(layer.x ?? 0.5));
      const y = clamp01(Number(layer.y ?? 0.2));
      const color = ffmpegColor(String(layer.color ?? '#ffffff'), opacity);
      const bg = ffmpegColor(String(layer.backgroundColor ?? 'transparent'), opacity);
      const hasBox = bg !== '0x000000@0';
      const options = [
        ...(fontFile ? [`fontfile='${escapeFilterValue(fontFile)}'`] : []),
        `textfile='${escapeFilterValue(textFile)}'`,
        `fontcolor=${color}`, `fontsize=${fontSize}`,
        'borderw=1.5', 'bordercolor=0x000000@0.85',
        ...(hasBox ? ['box=1', `boxcolor=${bg}`, 'boxborderw=14'] : []),
        `x=w*${x.toFixed(4)}-text_w/2`,
        `y=h*${y.toFixed(4)}-text_h/2`,
        `enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'`,
      ];
      filters.push(`drawtext=${options.join(':')}`);
    }
    if (layer.type === 'lyrics') {
      const lrc = String(layer.lrcContent ?? '').trim();
      if (!lrc) continue;
      const rows = parseEditorLrcLines(lrc);
      if (rows.length === 0) continue;
      const layerStart = safeLayerTime(layer.startTime, 0, videoDuration);
      const layerEnd = safeLayerTime(Number(layer.startTime ?? 0) + Number(layer.duration ?? videoDuration), videoDuration, videoDuration);
      const opacity = clamp01(Number(layer.opacity ?? 1));
      const fontSizeRaw = Number(layer.fontSize ?? 58);
      const fontSize = fontSizeRaw > 0 && fontSizeRaw <= 20
        ? `h*${(fontSizeRaw / 100).toFixed(4)}`
        : String(Math.max(16, Math.min(220, fontSizeRaw || 58)));
      const y = lyricsYExpression(String(layer.position ?? 'lower-third'));
      const color = ffmpegColor(String(layer.highlightColor || layer.color || '#04F827'), opacity);
      const stroke = ffmpegColor(String(layer.strokeColor || '#000000'), opacity);
      const strokeWidth = Math.max(0, Math.min(8, Number(layer.strokeWidth ?? 2)));
      const bg = ffmpegColor(String(layer.backgroundColor ?? 'rgba(0,0,0,0.42)'), opacity);
      rows.forEach((row, index) => {
        const start = Math.max(layerStart, row.time);
        const nextTime = rows[index + 1]?.time ?? layerEnd;
        const end = Math.min(layerEnd, Math.max(start + 0.12, nextTime - 0.03));
        if (start >= videoDuration || end <= start) return;
        const textFile = writeEditorTextFile(workDir, `${layer.id}-${index}`, row.text);
        const options = [
          ...(fontFile ? [`fontfile='${escapeFilterValue(fontFile)}'`] : []),
          `textfile='${escapeFilterValue(textFile)}'`,
          `fontcolor=${color}`, `fontsize=${fontSize}`,
          `borderw=${strokeWidth}`, `bordercolor=${stroke}`,
          'box=1', `boxcolor=${bg}`, 'boxborderw=16',
          'x=(w-text_w)/2', `y=${y}`,
          `enable='between(t,${start.toFixed(3)},${Math.min(end, videoDuration).toFixed(3)})'`,
        ];
        filters.push(`drawtext=${options.join(':')}`);
      });
    }
  }
  return filters.join(',');
}

function writeEditorTextFile(workDir: string, id: string, text: string): string {
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  const filePath = path.join(workDir, `${safeId || randomUUID()}.txt`);
  fs.writeFileSync(filePath, text, 'utf8');
  return filePath;
}

function findEditorFontFile(): string | null {
  const candidates = [
    '/System/Library/Fonts/PingFang.ttc',
    '/System/Library/Fonts/STHeiti Light.ttc',
    '/Library/Fonts/Arial Unicode.ttf',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

function escapeFilterValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function safeLayerTime(value: unknown, fallback: number, duration: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return Math.max(0, Math.min(duration, fallback));
  return Math.max(0, Math.min(duration, n));
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
}

function ffmpegColor(value: string, layerOpacity = 1): string {
  const v = value.trim();
  if (!v || v === 'transparent') return '0x000000@0';
  const hex = v.match(/^#([0-9a-fA-F]{6})$/);
  if (hex) return `0x${hex[1]}@${clamp01(layerOpacity)}`;
  const rgba = v.match(/^rgba?\((\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})(?:,\s*([0-9.]+))?\)$/i);
  if (rgba) {
    const r = Math.max(0, Math.min(255, Number(rgba[1])));
    const g = Math.max(0, Math.min(255, Number(rgba[2])));
    const b = Math.max(0, Math.min(255, Number(rgba[3])));
    const a = clamp01(Number(rgba[4] ?? 1) * layerOpacity);
    return `0x${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}@${a}`;
  }
  return `0xffffff@${clamp01(layerOpacity)}`;
}

function lyricsYExpression(position: string): string {
  if (position === 'top') return 'h*0.16-text_h/2';
  if (position === 'middle' || position === 'center') return 'h*0.5-text_h/2';
  return 'h*0.82-text_h/2';
}
