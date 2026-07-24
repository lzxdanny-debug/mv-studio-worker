import React, { useMemo } from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';

export type LyricsOverlayProps = {
  lrcContent: string;
  durationSec: number;
  width: number;
  height: number;
  config: {
    lyricsV2Preset?: string;
    position?: string;
    fontSizePct?: number;
    maxLines?: number;
  };
};

type Line = { start: number; end: number; text: string };
const parseLrc = (source: string, duration: number): Line[] => {
  const rows: Array<{ start: number; text: string }> = [];
  for (const raw of source.split(/\r?\n/)) {
    const match = raw.match(/^\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\](.*)$/);
    if (!match) continue;
    const fraction = match[3] ? Number(`0.${match[3]}`) : 0;
    const text = match[4].replace(/<\d{1,2}:\d{2}(?:\.\d{1,3})?>/g, '').replace(/\[(?:M|F|D)\]/gi, '').trim();
    if (text) rows.push({ start: Number(match[1]) * 60 + Number(match[2]) + fraction, text });
  }
  rows.sort((a, b) => a.start - b.start);
  return rows.map((row, index) => ({ ...row, end: rows[index + 1]?.start ?? duration }));
};

type Spec = { family: string; fill: string; accent: string; stroke: string; sw: number; shadow: string; motion: string; stacked?: boolean; backdrop?: string; italic?: boolean };
const SPECS: Record<string, Spec> = {
  karaoke: { family: 'Arial Black, sans-serif', fill: '#e7e7e7', accent: '#fff', stroke: '#171717', sw: 3, shadow: '3px 4px 0 #050505', motion: 'karaoke', stacked: true },
  beasty: { family: 'Arial Black, sans-serif', fill: '#f3f3f3', accent: '#fff', stroke: '#414141', sw: 4, shadow: '0 0 14px #fff,4px 5px 0 #222', motion: 'bounce', stacked: true, italic: true },
  'deep-diver': { family: 'Arial Black, sans-serif', fill: '#8c8c8c', accent: '#ddd', stroke: '#252525', sw: 1.5, shadow: 'none', motion: 'fade', stacked: true },
  youshaei: { family: 'Arial Black, sans-serif', fill: '#57545a', accent: '#8d8990', stroke: '#171719', sw: 3, shadow: '2px 3px 0 #050505', motion: 'pop', stacked: true },
  'pod-p': { family: 'Arial Black, sans-serif', fill: '#ec29d2', accent: '#ff5be8', stroke: '#180817', sw: 3, shadow: '3px 4px 0 #000', motion: 'pop', stacked: true },
  mozi: { family: 'Arial Black, sans-serif', fill: '#f5f5f5', accent: '#fff', stroke: '#070707', sw: 4, shadow: '3px 5px 0 #000', motion: 'karaoke', stacked: true },
  popline: { family: 'Arial Black, sans-serif', fill: '#f4f4f4', accent: '#fff', stroke: '#111', sw: 3, shadow: '2px 4px 0 #050505', motion: 'pop' },
  'glitch-infinite': { family: 'Arial Black, sans-serif', fill: '#ffb000', accent: '#ffdb2e', stroke: '#2d1700', sw: 3, shadow: '6px 5px 0 #e72c26,-3px 0 0 #111', motion: 'glitch', stacked: true },
  'seamless-bounce': { family: 'Arial Black, sans-serif', fill: '#f0e6df', accent: '#fff', stroke: '#24623b', sw: 7, shadow: '6px 5px 0 #9d3a2e', motion: 'bounce' },
  'baby-earthquake': { family: 'Georgia,serif', fill: '#e2e2e2', accent: '#fff', stroke: '#28643b', sw: 7, shadow: 'none', motion: 'quake', stacked: true },
  'blur-switch': { family: 'Arial Black,sans-serif', fill: '#dedede', accent: '#fff', stroke: '#29613a', sw: 7, shadow: '5px 4px 0 #a3402e', motion: 'blur', stacked: true },
  'highlighter-box': { family: 'Impact,sans-serif', fill: '#e7e7e7', accent: '#fff', stroke: '#d76b9c', sw: 5, shadow: '0 5px 8px #f22', motion: 'highlight' },
  simple: { family: 'Arial Black,sans-serif', fill: '#fff', accent: '#fff', stroke: '#060606', sw: 4, shadow: '2px 3px 0 #111', motion: 'fade' },
  'think-media': { family: 'Impact,sans-serif', fill: '#eee', accent: '#fff', stroke: '#141414', sw: 2.5, shadow: '3px 4px 0 #111', motion: 'pop', italic: true },
  focus: { family: 'Arial Black,sans-serif', fill: '#f7f7f7', accent: '#fff', stroke: '#292929', sw: 4, shadow: '0 0 9px #fff6', motion: 'fade' },
  'blur-in': { family: 'Georgia,serif', fill: '#ddd', accent: '#fff', stroke: '#1b1b1b', sw: 2, shadow: '0 0 10px #000', motion: 'blur', stacked: true },
  'with-backdrop': { family: 'Arial Black,sans-serif', fill: '#d9ef69', accent: '#efffa0', stroke: '#111', sw: 2, shadow: '2px 3px 0 #000', motion: 'pop', backdrop: '#0c0c0cad', italic: true },
};
const clamp = (v: number) => Math.max(0, Math.min(1, v));

export const LyricsOverlay: React.FC<LyricsOverlayProps> = ({ lrcContent, durationSec, config }) => {
  const frame = useCurrentFrame(); const { fps } = useVideoConfig(); const now = frame / fps;
  const lines = useMemo(() => parseLrc(lrcContent, durationSec), [lrcContent, durationSec]);
  const line = lines.find((item) => now >= item.start && now < item.end);
  if (!line) return <AbsoluteFill style={{ backgroundColor: 'transparent' }} />;
  const words = line.text.split(/\s+/).filter(Boolean);
  const progress = clamp((now - line.start) / Math.max(.25, line.end - line.start));
  const spec = SPECS[config.lyricsV2Preset ?? 'mozi'] ?? SPECS.mozi;
  const maxLines = Math.max(1, Math.min(2, Math.round(config.maxLines ?? 2)));
  const shouldStack = spec.stacked && maxLines > 1 && words.length > 1;
  const splitAt = shouldStack ? Math.ceil(words.length / 2) : words.length;
  const rows = shouldStack ? [words.slice(0, splitAt), words.slice(splitAt)] : [words];
  const longestRowChars = Math.max(...rows.map((row) => row.join(' ').length), 1);
  const sizePct = Math.max(
    2.8,
    (config.fontSizePct ?? 5.4) * Math.min(1, 16 / Math.max(10, longestRowChars)),
  );
  const position = config.position === 'top' ? { top: '8%' } : config.position === 'center' ? { top: '48%', transform: 'translateY(-50%)' } : { bottom: config.position === 'bottom' ? '8%' : '20%' };
  return <AbsoluteFill style={{ backgroundColor: 'transparent' }}>
    <div style={{ position: 'absolute', left: '4%', right: '4%', display: 'flex', justifyContent: 'center', textAlign: 'center', ...position }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, maxWidth: '96%', background: spec.backdrop, borderRadius: spec.backdrop ? 14 : 0, padding: spec.backdrop ? '12px 20px' : 0 }}>
        {rows.map((row, rowIndex) => <div key={rowIndex} style={{ display: 'flex', flexWrap: 'nowrap', alignItems: 'center', justifyContent: 'center', gap: '6px 12px', maxWidth: '100%' }}>
        {row.map((word, rowWordIndex) => {
          const i = (rows.length > 1 && rowIndex === 1 ? splitAt : 0) + rowWordIndex;
          const active = progress >= (i + 1) / words.length;
          return <span key={`${word}-${i}`} style={{ display: 'inline-block', whiteSpace: 'nowrap', fontFamily: spec.family, fontWeight: 900, fontStyle: spec.italic ? 'italic' : undefined, fontSize: `${sizePct}vh`, lineHeight: .98, letterSpacing: '-.025em', textTransform: 'uppercase', color: (spec.motion === 'karaoke' || spec.motion === 'highlight') && active ? spec.accent : spec.fill, WebkitTextStroke: `${spec.sw}px ${spec.stroke}`, paintOrder: 'stroke fill', textShadow: spec.shadow, filter: 'none', opacity: 1, background: spec.motion === 'highlight' && active ? '#d96a9d' : undefined }}>{word}</span>;
        })}</div>)}
      </div>
    </div>
  </AbsoluteFill>;
};
