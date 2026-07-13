export function getCanvasSize(aspectRatio: string | null | undefined): { width: number; height: number } {
  const ar = (aspectRatio ?? '').trim();
  const presets: Record<string, { width: number; height: number }> = {
    '16:9': { width: 1280, height: 720 },
    '9:16': { width: 720, height: 1280 },
    '1:1': { width: 1024, height: 1024 },
    '4:3': { width: 960, height: 720 },
    '3:4': { width: 720, height: 960 },
    '21:9': { width: 1680, height: 720 },
    '4:5': { width: 720, height: 900 },
    '5:4': { width: 900, height: 720 },
  };
  if (presets[ar]) return presets[ar];
  const m = ar.match(/^(\d+(?:\.\d+)?)\s*[:x]\s*(\d+(?:\.\d+)?)$/);
  if (m) {
    const a = parseFloat(m[1]);
    const b = parseFloat(m[2]);
    if (a > 0 && b > 0) {
      const ratio = a / b;
      if (ratio >= 1) return { width: Math.round((720 * ratio) / 2) * 2, height: 720 };
      return { width: 720, height: Math.round((720 / ratio) / 2) * 2 };
    }
  }
  return { width: 1280, height: 720 };
}

export function getColorGradeFilter(styleTag: string): string {
  const tag = (styleTag || '').toLowerCase();
  if (
    tag.includes('neon') || tag.includes('cyber') || tag.includes('hi_energy')
    || tag.includes('energetic') || tag.includes('rap') || tag.includes('hiphop')
  ) {
    return 'eq=contrast=1.12:saturation=1.25:brightness=0.03,unsharp=3:3:0.4,noise=alls=2:allf=t';
  }
  if (
    tag.includes('film') || tag.includes('rock') || tag.includes('retro')
    || tag.includes('vintage') || tag.includes('punk')
  ) {
    return 'eq=contrast=1.08:saturation=1.1:brightness=-0.02:gamma_r=1.05:gamma_b=0.95,noise=alls=4:allf=t';
  }
  if (
    tag.includes('rnb') || tag.includes('soul') || tag.includes('ballad')
    || tag.includes('lyric') || tag.includes('romantic')
  ) {
    return 'eq=contrast=1.05:saturation=0.92:brightness=0.02:gamma_b=1.06,noise=alls=1:allf=t';
  }
  return '';
}

export function truncateAssByDuration(ass: string, maxSec: number): string {
  return ass
    .split('\n')
    .filter((line) => {
      if (!line.startsWith('Dialogue:')) return true;
      const parts = line.split(',');
      if (parts.length < 3) return true;
      const start = parseAssTime(parts[1].trim());
      return start < maxSec;
    })
    .join('\n');
}

function parseAssTime(t: string): number {
  const m = t.match(/^(\d+):(\d{2}):(\d{2})\.(\d{2})$/);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 100;
}
