#!/usr/bin/env node
/**
 * MV Studio — 视频合成性能压测（按 MV 时长 × 并发数矩阵）
 * ==========================================================
 *
 * 目的：在测试环境量化「合成一条 N 秒 MV 需要多少 CPU / 内存 / 磁盘 / 时间」，
 *      以及「多路并发合成对同机其它业务的资源冲击」，为容量规划与是否拆
 *      独立 worker 提供实测依据。
 *
 * 编码链路严格对齐生产 mv-composition.service.ts 的 spawnFfmpeg：
 *   逐镜 trim(scale+crop+fade, libx264 preset=fast crf=20 -an)
 *     → concat copy
 *     → 混音(libx264 preset=fast crf=20 + aac 320k + faststart)
 *     → [可选] 调色(eq/unsharp/noise)
 *     → [可选] 字幕烧录(libass 全片重编码)
 *
 * 采集指标（Linux 用 /proc 精确采集，macOS 用 ps 兜底）：
 *   - 每个 ffmpeg 进程：墙钟时间、CPU 秒数、CPU 利用率(核)、峰值 RSS
 *   - 系统级：压测期间整机 CPU 利用率、loadavg 前后对比
 *   - 每路合成：实时因子(编码耗时/成片时长)、临时磁盘峰值
 *   - 并发：争抢因子、单路劣化倍数
 *
 * 用法：
 *   node scripts/benchmark-compose.mjs
 *   node scripts/benchmark-compose.mjs --durations 60,180 --concurrency 1,5,10,15
 *   node scripts/benchmark-compose.mjs --durations 60 --concurrency 1,2,3 --with-subtitle --with-grade
 *   node scripts/benchmark-compose.mjs --duration 180 --concurrency 10 --tmp-dir /data/mv-bench --report /data/mv-bench/report.md
 *
 * 依赖：ffmpeg、ffprobe（与生产同一套）。不写数据库、不访问网络、不上传 COS。
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const execFileAsync = promisify(execFile);
const IS_LINUX = process.platform === 'linux';
const CLK_TCK = 100; // Linux 时钟节拍，绝大多数发行版为 100

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    durations: [60],       // MV 目标时长（秒），可多档做扫描
    clipSec: 5,            // 每镜时长（Seedance 常见 5s / 10s）
    aspectRatio: '16:9',   // 16:9 | 9:16 | 1:1
    concurrency: [1, 2],   // 并发合成路数，可多档
    withSubtitle: false,   // 额外字幕烧录 pass
    withGrade: false,      // 额外调色 pass
    report: '',            // Markdown 报告输出路径
    keepWorkdir: false,
    tmpDir: process.env.MV_BENCH_TMP_DIR || '', // 临时工作目录根（默认 os.tmpdir()）
    sampleMs: 300,         // 资源采样间隔
    ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
    ffprobe: process.env.FFPROBE_PATH || 'ffprobe',
  };
  const num = (s) => Number(String(s).trim());
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--durations') opts.durations = argv[++i].split(',').map(num).filter((n) => n > 0);
    else if (a === '--duration') opts.durations = [num(argv[++i])];
    else if (a === '--clip-sec') opts.clipSec = num(argv[++i]);
    else if (a === '--aspect') opts.aspectRatio = argv[++i];
    else if (a === '--concurrency') opts.concurrency = argv[++i].split(',').map(num).filter((n) => n > 0);
    else if (a === '--with-subtitle') opts.withSubtitle = true;
    else if (a === '--with-grade') opts.withGrade = true;
    else if (a === '--report') opts.report = argv[++i];
    else if (a === '--keep-workdir') opts.keepWorkdir = true;
    else if (a === '--tmp-dir') opts.tmpDir = argv[++i];
    else if (a === '--sample-ms') opts.sampleMs = num(argv[++i]);
    else if (a === '--ffmpeg') opts.ffmpeg = argv[++i];
    else if (a === '--ffprobe') opts.ffprobe = argv[++i];
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`用法: node scripts/benchmark-compose.mjs [选项]

核心参数:
  --durations 60,180     MV 目标时长扫描（秒，默认 60）
  --duration 180         单一 MV 时长（等价 --durations 180）
  --concurrency 1,5,10   并发合成路数扫描（默认 1,2）
  --clip-sec 5           每镜时长（秒，默认 5；镜头数 = ceil(时长/每镜)）
  --aspect 16:9          画幅 16:9 | 9:16 | 1:1（默认 16:9）

可选 pass:
  --with-grade           额外跑调色（eq/unsharp/noise 全片重编码）
  --with-subtitle        额外跑字幕烧录（libass 全片重编码）

其它:
  --report PATH          Markdown 报告输出路径（默认写入临时目录）
  --tmp-dir PATH         合成临时目录根（默认 /tmp；大并发建议挂数据盘）
  --sample-ms N          资源采样间隔毫秒（默认 300）
  --keep-workdir         保留临时目录便于排查
  --ffmpeg / --ffprobe   指定二进制路径（默认取 PATH 或 FFMPEG_PATH）

示例:
  node scripts/benchmark-compose.mjs --durations 60,180 --concurrency 1,5,10,15
  node scripts/benchmark-compose.mjs --duration 180 --concurrency 10 --tmp-dir /data/mv-bench --report /data/mv-bench/report.md
  node scripts/benchmark-compose.mjs --duration 60 --aspect 9:16 --with-subtitle
`);
}

function benchTmpRoot(opts) {
  const base = opts.tmpDir?.trim() || os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return base;
}

// ── 环境探测 ───────────────────────────────────────────────────────────────

async function detectCpuCores() {
  // os.availableParallelism 优先（Node 18.14+，尊重 cgroup 限额）
  try {
    if (typeof os.availableParallelism === 'function') {
      const n = os.availableParallelism();
      if (n > 0) return n;
    }
  } catch { /* ignore */ }
  const byOs = os.cpus()?.length ?? 0;
  if (byOs > 0) return byOs;
  // 兜底：nproc / sysctl
  try {
    const { stdout } = await execFileAsync(IS_LINUX ? 'nproc' : 'sysctl', IS_LINUX ? [] : ['-n', 'hw.ncpu']);
    const n = Number(stdout.trim());
    if (n > 0) return n;
  } catch { /* ignore */ }
  return 1;
}

function getCpuModel() {
  return os.cpus()?.[0]?.model?.trim() ?? 'unknown';
}

// ── 进程资源采样（RSS + CPU 秒）──────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 读取单进程 RSS(KB)。Linux 走 /proc，macOS 走 ps。返回 0 表示进程已退出或读取失败。 */
async function readRssKb(pid) {
  if (IS_LINUX) {
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const m = status.match(/VmRSS:\s+(\d+)\s+kB/);
      return m ? Number(m[1]) : 0;
    } catch {
      return 0;
    }
  }
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'rss=', '-p', String(pid)]);
    return Number(stdout.trim()) || 0;
  } catch {
    return 0;
  }
}

/** 读取单进程累计 CPU 秒（utime+stime）。Linux 走 /proc/<pid>/stat，macOS 走 ps cputime。 */
async function readCpuSec(pid) {
  if (IS_LINUX) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      // comm 可能含空格/括号，取最后一个 ')' 之后的字段
      const after = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/);
      // after[0] = state(field3)，utime=field14→after[11]，stime=field15→after[12]
      const utime = Number(after[11]) || 0;
      const stime = Number(after[12]) || 0;
      return (utime + stime) / CLK_TCK;
    } catch {
      return 0;
    }
  }
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'cputime=', '-p', String(pid)]);
    return parseCpuTime(stdout.trim());
  } catch {
    return 0;
  }
}

/** 解析 ps cputime 形如 [dd-]hh:mm:ss(.ss) → 秒 */
function parseCpuTime(s) {
  if (!s) return 0;
  let days = 0;
  if (s.includes('-')) {
    const [d, rest] = s.split('-');
    days = Number(d) || 0;
    s = rest;
  }
  const parts = s.split(':').map(Number);
  let sec = 0;
  for (const p of parts) sec = sec * 60 + (Number.isFinite(p) ? p : 0);
  return sec + days * 86400;
}

/**
 * 监控一个子进程直到它退出，返回 { peakRssMb, cpuSec }。
 * 持续采样 RSS 取峰值；CPU 秒在退出前尽量抓最后一个有效值（单调递增）。
 */
function monitorProcess(pid, intervalMs) {
  const state = { peakRssKb: 0, lastCpuSec: 0, stopped: false };
  const loop = (async () => {
    while (!state.stopped) {
      const [rss, cpu] = await Promise.all([readRssKb(pid), readCpuSec(pid)]);
      if (rss > state.peakRssKb) state.peakRssKb = rss;
      if (cpu > state.lastCpuSec) state.lastCpuSec = cpu;
      if (rss === 0 && cpu === 0) break; // 进程可能已退出
      await sleep(intervalMs);
    }
  })();
  return {
    stop: async () => {
      state.stopped = true;
      await loop;
      return {
        peakRssMb: round2(state.peakRssKb / 1024),
        cpuSec: round2(state.lastCpuSec),
      };
    },
  };
}

// ── 系统级 CPU 采样（Linux /proc/stat）────────────────────────────────────────

function readProcStatTotals() {
  if (!IS_LINUX) return null;
  try {
    const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0]; // "cpu  ..."
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = (parts[3] || 0) + (parts[4] || 0); // idle + iowait
    const total = parts.reduce((a, b) => a + (b || 0), 0);
    return { idle, total };
  } catch {
    return null;
  }
}

/** 返回一个句柄，stop() 给出压测期间整机平均 CPU 利用率(0-1) */
function startSystemCpuMeter() {
  const start = readProcStatTotals();
  return {
    stop: () => {
      const end = readProcStatTotals();
      if (!start || !end) return null;
      const dTotal = end.total - start.total;
      const dIdle = end.idle - start.idle;
      if (dTotal <= 0) return null;
      return round2(1 - dIdle / dTotal); // 0-1，整机平均占用
    },
  };
}

function getLoadAvg() {
  const [a, b, c] = os.loadavg();
  return { '1m': round2(a), '5m': round2(b), '15m': round2(c) };
}

// ── FFmpeg 执行 ───────────────────────────────────────────────────────────────

async function checkFfmpeg(ffmpeg) {
  const { stdout } = await execFileAsync(ffmpeg, ['-version']);
  return stdout.split('\n')[0];
}

/** 运行一次 ffmpeg，附带资源监控，返回 { label, wallMs, cpuSec, cpuCores, peakRssMb } */
async function runFfmpeg(ffmpeg, args, label, sampleMs) {
  const t0 = Date.now();
  const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 8000) stderr = stderr.slice(-8000); });

  const monitor = proc.pid ? monitorProcess(proc.pid, sampleMs) : null;

  await new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} 失败 exit=${code}: ${stderr.slice(-600)}`));
    });
  });

  const wallMs = Date.now() - t0;
  const res = monitor ? await monitor.stop() : { peakRssMb: 0, cpuSec: 0 };
  return {
    label,
    wallMs,
    cpuSec: res.cpuSec,
    cpuCores: wallMs > 0 ? round2(res.cpuSec / (wallMs / 1000)) : 0, // 平均占用核数
    peakRssMb: res.peakRssMb,
  };
}

async function probeDuration(ffprobe, filePath) {
  const { stdout } = await execFileAsync(ffprobe, [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', filePath,
  ]);
  return parseFloat(stdout.trim()) || 0;
}

function dirSizeBytes(dir) {
  let total = 0;
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return 0; }
  for (const name of entries) {
    const p = path.join(dir, name);
    try {
      const st = fs.statSync(p);
      total += st.isDirectory() ? dirSizeBytes(p) : st.size;
    } catch { /* ignore */ }
  }
  return total;
}

// ── Canvas（对齐 mv-composition.service.ts getCanvasSize）──────────────────────

function getCanvasSize(aspectRatio) {
  const presets = {
    '16:9': { width: 1280, height: 720 },
    '9:16': { width: 720, height: 1280 },
    '1:1': { width: 1024, height: 1024 },
  };
  return presets[aspectRatio] ?? presets['16:9'];
}

// ── 素材生成 ───────────────────────────────────────────────────────────────

async function generateSyntheticClip(ffmpeg, outPath, canvas, durationSec, sampleMs) {
  // testsrc2 比 testsrc 有更复杂的画面，编码负载更接近真实 AI 视频
  await runFfmpeg(ffmpeg, [
    '-y', '-f', 'lavfi',
    '-i', `testsrc2=duration=${durationSec}:size=${canvas.width}x${canvas.height}:rate=24`,
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-an',
    outPath,
  ], 'gen-clip', sampleMs);
}

async function generateSyntheticAudio(ffmpeg, outPath, durationSec, sampleMs) {
  await runFfmpeg(ffmpeg, [
    '-y', '-f', 'lavfi',
    '-i', `sine=frequency=440:duration=${durationSec}`,
    '-c:a', 'libmp3lame', '-q:a', '2',
    outPath,
  ], 'gen-audio', sampleMs);
}

function buildMinimalAss(workDir, canvas, durationSec) {
  const assPath = path.join(workDir, 'lyrics.ass');
  const end = Math.max(4, Math.min(Math.floor(durationSec), 3599));
  const hh = String(Math.floor(end / 3600)).padStart(1, '0');
  const mm = String(Math.floor((end % 3600) / 60)).padStart(2, '0');
  const ss = String(end % 60).padStart(2, '0');
  const content = `[Script Info]
ScriptType: v4.00+
PlayResX: ${canvas.width}
PlayResY: ${canvas.height}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Noto Sans CJK SC,48,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2,0,2,40,40,60,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,压测字幕行 一二三四五
Dialogue: 0,0:00:04.00,${hh}:${mm}:${ss}.00,Default,,0,0,0,,Benchmark subtitle line 2
`;
  fs.writeFileSync(assPath, content, 'utf8');
  return assPath;
}

// ── 单路合成（对齐生产链路）────────────────────────────────────────────────

async function runComposeOnce(opts, durationSec, runId) {
  const canvas = getCanvasSize(opts.aspectRatio);
  const shots = Math.max(1, Math.ceil(durationSec / opts.clipSec));
  const workDir = path.join(benchTmpRoot(opts), `mv-bench-${runId}`);
  fs.mkdirSync(workDir, { recursive: true });

  const stages = [];
  const t0 = Date.now();
  let peakDiskMb = 0;
  const trackDisk = () => {
    const mb = round2(dirSizeBytes(workDir) / 1024 / 1024);
    if (mb > peakDiskMb) peakDiskMb = mb;
  };

  try {
    // 0. 生成素材（不计入编码耗时，只为提供输入）
    const clipsDir = path.join(workDir, 'clips');
    fs.mkdirSync(clipsDir);
    const clipPaths = [];
    for (let i = 0; i < shots; i++) {
      const p = path.join(clipsDir, `clip_${String(i).padStart(3, '0')}.mp4`);
      await generateSyntheticClip(opts.ffmpeg, p, canvas, opts.clipSec, opts.sampleMs);
      clipPaths.push(p);
    }
    const audioPath = path.join(workDir, 'music.mp3');
    await generateSyntheticAudio(opts.ffmpeg, audioPath, durationSec, opts.sampleMs);
    trackDisk();

    // 1. 逐镜 trim（scale+crop+fade，串行，生产最耗 CPU 环节之一）
    const trimDir = path.join(workDir, 'trimmed');
    fs.mkdirSync(trimDir);
    const scaleFilter =
      `scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=increase,` +
      `crop=${canvas.width}:${canvas.height},fps=24`;
    const trimmedPaths = [];
    for (let i = 0; i < clipPaths.length; i++) {
      const trimmedPath = path.join(trimDir, `trimmed_${String(i).padStart(3, '0')}.mp4`);
      const fadeFilters = [];
      if (i > 0) fadeFilters.push('fade=t=in:st=0:d=0.200');
      if (i < clipPaths.length - 1) {
        fadeFilters.push(`fade=t=out:st=${(opts.clipSec - 0.2).toFixed(3)}:d=0.200`);
      }
      const vfChain = [scaleFilter, ...fadeFilters].join(',');
      stages.push(await runFfmpeg(opts.ffmpeg, [
        '-y', '-i', clipPaths[i], '-t', String(opts.clipSec),
        '-vf', vfChain,
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-an',
        trimmedPath,
      ], `trim ${i + 1}/${shots}`, opts.sampleMs));
      trimmedPaths.push(trimmedPath);
      trackDisk();
    }

    // 2. concat（stream copy，几乎不占 CPU）
    const concatList = path.join(workDir, 'concat.txt');
    fs.writeFileSync(concatList, trimmedPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
    const concatOut = path.join(workDir, 'concat_output.mp4');
    stages.push(await runFfmpeg(opts.ffmpeg, [
      '-y', '-f', 'concat', '-safe', '0', '-i', concatList, '-c', 'copy', concatOut,
    ], 'concat(copy)', opts.sampleMs));
    trackDisk();

    const concatDuration = await probeDuration(opts.ffprobe, concatOut);
    const effectiveDuration = Math.min(concatDuration, durationSec);

    // 3. 混音（全片重编码，耗时最长环节之一）
    let finalPath = path.join(workDir, 'output.mp4');
    stages.push(await runFfmpeg(opts.ffmpeg, [
      '-y', '-i', concatOut, '-i', audioPath,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
      '-c:a', 'aac', '-b:a', '320k',
      '-t', String(effectiveDuration),
      '-map', '0:v:0', '-map', '1:a:0', '-movflags', '+faststart',
      finalPath,
    ], 'mix', opts.sampleMs));
    trackDisk();

    // 4. 可选调色
    if (opts.withGrade) {
      const graded = path.join(workDir, 'output_graded.mp4');
      stages.push(await runFfmpeg(opts.ffmpeg, [
        '-y', '-i', finalPath,
        '-vf', 'eq=contrast=1.12:saturation=1.25:brightness=0.03,unsharp=3:3:0.4,noise=alls=2:allf=t',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-c:a', 'copy',
        graded,
      ], 'color-grade', opts.sampleMs));
      finalPath = graded;
      trackDisk();
    }

    // 5. 可选字幕烧录
    if (opts.withSubtitle) {
      const assPath = buildMinimalAss(workDir, canvas, effectiveDuration);
      const subbed = path.join(workDir, 'output_subbed.mp4');
      const safeAss = assPath.replace(/\\/g, '/').replace(/'/g, "'\\''").replace(/:/g, '\\:');
      stages.push(await runFfmpeg(opts.ffmpeg, [
        '-y', '-i', finalPath,
        '-vf', `subtitles=filename='${safeAss}'`,
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-c:a', 'copy',
        '-movflags', '+faststart', subbed,
      ], 'subtitle-burn', opts.sampleMs));
      finalPath = subbed;
      trackDisk();
    }

    const wallMs = Date.now() - t0;
    const encodeStages = stages.filter((s) => !s.label.startsWith('gen-') && s.label !== 'concat(copy)');
    const encodeWallMs = encodeStages.reduce((s, x) => s + x.wallMs, 0);
    const encodeCpuSec = encodeStages.reduce((s, x) => s + x.cpuSec, 0);
    const peakRssMb = Math.max(0, ...stages.map((s) => s.peakRssMb));

    return {
      runId,
      durationSec,
      shots,
      clipSec: opts.clipSec,
      aspectRatio: opts.aspectRatio,
      canvas: `${canvas.width}x${canvas.height}`,
      effectiveDurationSec: round2(effectiveDuration),
      wallMs,
      encodeWallMs,
      encodeCpuSec: round2(encodeCpuSec),
      /** 编码墙钟 / 成片时长；>1 表示比实时慢 */
      realtimeFactor: round2(encodeWallMs / 1000 / (effectiveDuration || 1)),
      /** 编码 CPU 秒 / 成片时长；反映真实 CPU 成本（含多线程） */
      cpuFactor: round2(encodeCpuSec / (effectiveDuration || 1)),
      peakRssMb,
      peakDiskMb,
      stages,
    };
  } finally {
    if (!opts.keepWorkdir) {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

// ── 一个矩阵格子：某时长 × 某并发 ───────────────────────────────────────────

async function runCell(opts, durationSec, concurrency) {
  const loadBefore = getLoadAvg();
  const sysMeter = startSystemCpuMeter();
  const t0 = Date.now();

  const runs = await Promise.all(
    Array.from({ length: concurrency }, (_, i) =>
      runComposeOnce(opts, durationSec, `d${durationSec}-c${concurrency}-${i}-${randomUUID().slice(0, 6)}`),
    ),
  );

  const totalWallMs = Date.now() - t0;
  const sysCpu = sysMeter.stop();
  const loadAfter = getLoadAvg();

  const sumWall = runs.reduce((s, r) => s + r.wallMs, 0);
  const avg = (sel) => round2(runs.reduce((s, r) => s + sel(r), 0) / runs.length);

  return {
    durationSec,
    concurrency,
    shots: runs[0]?.shots ?? 0,
    totalWallMs,
    sumSingleWallMs: sumWall,
    /** 单路墙钟之和 / 并发总墙钟；≈concurrency=线性(无争抢)，趋近 1=严重争抢 */
    contentionFactor: round2(sumWall / totalWallMs),
    avgWallMs: round2(totalWallMs), // 并发下所有路完成的墙钟
    avgRealtimeFactor: avg((r) => r.realtimeFactor),
    avgCpuFactor: avg((r) => r.cpuFactor),
    peakRssMbTotal: round2(runs.reduce((s, r) => s + r.peakRssMb, 0)),
    peakDiskMbTotal: round2(runs.reduce((s, r) => s + r.peakDiskMb, 0)),
    sysCpuUtil: sysCpu,       // 0-1，整机平均占用（Linux）
    loadBefore,
    loadAfter,
    runs,
  };
}

// ── 工具 ─────────────────────────────────────────────────────────────────────

function round2(n) {
  return Math.round(n * 100) / 100;
}

function formatMs(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${round2(ms / 1000)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m${s}s`;
}

// ── 报告 ─────────────────────────────────────────────────────────────────────

function buildMarkdownReport(env, opts, cells) {
  const L = [];
  L.push('# MV Studio 视频合成性能压测报告');
  L.push('');
  L.push(`- 生成时间：${new Date().toISOString()}`);
  L.push(`- 主机：${os.hostname()} · ${os.platform()}/${os.arch()}`);
  L.push(`- CPU：**${env.cores} 核** · ${env.model}`);
  L.push(`- 内存：${round2(os.totalmem() / 1024 / 1024 / 1024)} GB`);
  L.push(`- FFmpeg：${env.ffmpegVersion}`);
  L.push(`- 参数：每镜 ${opts.clipSec}s · 画幅 ${opts.aspectRatio} · 调色=${opts.withGrade ? '是' : '否'} · 字幕=${opts.withSubtitle ? '是' : '否'}`);
  L.push(`- 时长档：${opts.durations.join(', ')}s · 并发档：${opts.concurrency.join(', ')}`);
  L.push('');

  L.push('## 名词说明');
  L.push('');
  L.push('| 指标 | 含义 |');
  L.push('|------|------|');
  L.push('| 实时因子 | 编码墙钟 ÷ 成片时长。2.0 = 合成 60s 片需 120s 墙钟 |');
  L.push('| CPU 因子 | 编码 CPU 秒 ÷ 成片时长。反映真实算力成本（含 x264 多线程），是容量规划的核心 |');
  L.push('| 争抢因子 | 单路墙钟之和 ÷ 并发总墙钟。≈并发数=线性扩展，趋近 1=严重争抢 |');
  L.push('| 整机 CPU | 压测期间整机平均 CPU 占用（0-100%，Linux 采集） |');
  L.push('');

  // 汇总矩阵
  L.push('## 1. 汇总矩阵（时长 × 并发）');
  L.push('');
  L.push('| 时长 | 镜头 | 并发 | 总墙钟 | 实时因子 | CPU因子 | 争抢因子 | 整机CPU | 内存合计 | 磁盘合计 |');
  L.push('|------|------|------|--------|----------|---------|----------|---------|----------|----------|');
  for (const c of cells) {
    L.push(
      `| ${c.durationSec}s | ${c.shots} | ${c.concurrency} | ${formatMs(c.totalWallMs)} | ` +
      `${c.avgRealtimeFactor} | ${c.avgCpuFactor} | ${c.contentionFactor} | ` +
      `${c.sysCpuUtil != null ? Math.round(c.sysCpuUtil * 100) + '%' : 'n/a'} | ` +
      `${c.peakRssMbTotal}MB | ${c.peakDiskMbTotal}MB |`,
    );
  }
  L.push('');

  // 单路阶段拆解（取第一个时长的并发=1）
  const single = cells.find((c) => c.concurrency === 1);
  if (single?.runs[0]) {
    const r = single.runs[0];
    L.push(`## 2. 单路阶段耗时拆解（${r.durationSec}s / ${r.shots} 镜）`);
    L.push('');
    L.push('| 阶段 | 墙钟 | CPU秒 | 平均占用核 | 峰值RSS |');
    L.push('|------|------|-------|-----------|---------|');
    for (const s of r.stages) {
      if (s.label.startsWith('gen-')) continue;
      L.push(`| ${s.label} | ${formatMs(s.wallMs)} | ${s.cpuSec} | ${s.cpuCores} | ${s.peakRssMb}MB |`);
    }
    L.push('');
    L.push(`- 成片实际时长：${r.effectiveDurationSec}s`);
    L.push(`- 编码墙钟合计：${formatMs(r.encodeWallMs)} · CPU 合计：${r.encodeCpuSec}s`);
    L.push(`- 实时因子 **${r.realtimeFactor}** · CPU 因子 **${r.cpuFactor}** · 峰值磁盘 ${r.peakDiskMb}MB`);
    L.push('');
  }

  // 并发劣化分析
  const concGroups = [...new Set(cells.map((c) => c.durationSec))];
  L.push('## 3. 并发劣化分析');
  L.push('');
  for (const dur of concGroups) {
    const group = cells.filter((c) => c.durationSec === dur).sort((a, b) => a.concurrency - b.concurrency);
    if (group.length < 2) continue;
    const base = group[0];
    L.push(`### ${dur}s MV`);
    L.push('');
    L.push('| 并发 | 总墙钟 | 相对单路劣化 | 争抢因子 | 整机CPU |');
    L.push('|------|--------|--------------|----------|---------|');
    for (const c of group) {
      const slowdown = base.totalWallMs > 0 ? round2(c.totalWallMs / base.totalWallMs) : 1;
      L.push(`| ${c.concurrency} | ${formatMs(c.totalWallMs)} | ${slowdown}× | ${c.contentionFactor} | ${c.sysCpuUtil != null ? Math.round(c.sysCpuUtil * 100) + '%' : 'n/a'} |`);
    }
    L.push('');
  }

  // 容量规划
  L.push('## 4. 容量规划建议');
  L.push('');
  if (single?.runs[0]) {
    const cpuFactor = single.avgCpuFactor;
    const cores = env.cores;
    // 安全并发：留 20% 余量给系统/其它业务
    const safe = Math.max(1, Math.floor((cores * 0.8) / Math.max(cpuFactor, 0.1)));
    L.push(`- 单机 **${cores} 核**，CPU 因子 ≈ **${cpuFactor}**（即合成 1s 成片消耗 ${cpuFactor}s CPU）`);
    L.push(`- 预留 20% 余量给系统/其它业务 → 建议 **安全并发合成数 ≤ ${safe}**`);
    L.push(`- 每路峰值内存约 **${single.runs[0].peakRssMb}MB**，临时磁盘约 **${single.runs[0].peakDiskMb}MB**`);
    L.push(`- N 路并发临时磁盘峰值 ≈ **${single.runs[0].peakDiskMb}MB × N**，需保证 /tmp 空间充足`);
  }
  L.push('');
  L.push('### 是否拆独立 mv-studio-worker？');
  L.push('');
  L.push('| 场景 | 建议 |');
  L.push('|------|------|');
  L.push('| 合成并发 ≤ 安全并发，且 API QPS 低 | 暂可单体，设 CPU limit 保护其它接口 |');
  L.push('| 合成并发接近/超过安全并发 | **拆独立 worker**，与 API 算力隔离（见 mv-studio-worker/docs） |');
  L.push('| 需按队列深度弹性扩缩 | **拆独立 worker** + 水平扩缩，API Pod 保持轻量可 HPA |');
  L.push('');
  L.push('> 观察指标：若「整机 CPU」在目标并发下持续 >80%，或「争抢因子」明显低于并发数，说明已到瓶颈，应降并发或拆服务扩容。');
  L.push('');

  return L.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv);

  let ffmpegVersion;
  try {
    ffmpegVersion = await checkFfmpeg(opts.ffmpeg);
  } catch {
    console.error(`[bench] 找不到 ffmpeg (${opts.ffmpeg})，请先安装或用 --ffmpeg 指定路径`);
    process.exit(1);
  }
  try {
    await execFileAsync(opts.ffprobe, ['-version']);
  } catch {
    console.error(`[bench] 找不到 ffprobe (${opts.ffprobe})，请先安装或用 --ffprobe 指定路径`);
    process.exit(1);
  }

  const cores = await detectCpuCores();
  const env = { cores, model: getCpuModel(), ffmpegVersion };

  console.log(`[bench] ${ffmpegVersion}`);
  console.log(`[bench] CPU: ${cores} 核 · ${env.model} · 平台 ${os.platform()}`);
  console.log(`[bench] 时长档: ${opts.durations.join(', ')}s · 并发档: ${opts.concurrency.join(', ')} · 每镜 ${opts.clipSec}s · ${opts.aspectRatio}`);
  console.log(`[bench] 采样间隔 ${opts.sampleMs}ms · 资源采集 ${IS_LINUX ? '/proc(精确)' : 'ps(兜底)'}`);
  console.log('');

  const cells = [];
  for (const dur of opts.durations) {
    for (const conc of opts.concurrency) {
      process.stdout.write(`[bench] ▶ ${dur}s × ${conc} 路 ...`);
      const cell = await runCell(opts, dur, conc);
      cells.push(cell);
      console.log(
        ` ✓ 墙钟 ${formatMs(cell.totalWallMs)} · 实时因子 ${cell.avgRealtimeFactor} · ` +
        `CPU因子 ${cell.avgCpuFactor} · 争抢 ${cell.contentionFactor} · ` +
        `整机CPU ${cell.sysCpuUtil != null ? Math.round(cell.sysCpuUtil * 100) + '%' : 'n/a'}`,
      );
    }
  }

  const report = buildMarkdownReport(env, opts, cells);
  console.log('\n' + '─'.repeat(64));
  console.log(report);
  console.log('─'.repeat(64));

  const reportPath = opts.report || path.join(os.tmpdir(), `mv-compose-benchmark-${Date.now()}.md`);
  fs.writeFileSync(reportPath, report, 'utf8');
  const jsonPath = reportPath.replace(/\.md$/, '') + '.json';
  fs.writeFileSync(jsonPath, JSON.stringify({ env, opts, cells }, null, 2), 'utf8');
  console.log(`[bench] Markdown 报告: ${reportPath}`);
  console.log(`[bench] JSON 数据:   ${jsonPath}`);
}

main().catch((err) => {
  console.error('\n[bench] 失败:', err.message);
  process.exit(1);
});
