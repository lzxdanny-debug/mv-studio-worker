import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WORKER_CONFIG } from '../config/worker.constants';
import type { WorkerCleanupScope } from '../contracts/worker-job.contract';
import { DownloaderService } from './storage.service';

const PROJECT_DIR_PREFIX = 'mv-studio-';

export interface WorkerClipCacheProjectSnapshot {
  projectId: string;
  bytes: number;
  fileCount: number;
  lastAccessAt: string | null;
}

export interface WorkerClipCacheStats {
  cacheBase: string;
  totalBytes: number;
  projectCount: number;
  fileCount: number;
  topProjects: WorkerClipCacheProjectSnapshot[];
}

@Injectable()
export class ClipCacheService {
  private readonly logger = new Logger(ClipCacheService.name);

  constructor(private readonly downloader: DownloaderService) {}

  resolveCacheBase(): string {
    const configured = WORKER_CONFIG.clipCacheDir?.trim();
    return configured || path.join(os.homedir(), '.mv-worker-cache');
  }

  projectDir(projectId: string): string {
    return path.join(this.resolveCacheBase(), `${PROJECT_DIR_PREFIX}${projectId}`);
  }

  async ensureClip(
    projectId: string,
    shotIndex: number,
    videoUrl: string,
    updatedAt?: string,
  ): Promise<string> {
    const dir = this.projectDir(projectId);
    fs.mkdirSync(dir, { recursive: true });
    const clipPath = path.join(dir, `clip_${String(shotIndex).padStart(3, '0')}.mp4`);
    const urlFile = `${clipPath}.url`;
    const fingerprint = `${videoUrl}|${updatedAt ?? ''}`;

    if (fs.existsSync(clipPath) && fs.existsSync(urlFile)) {
      const cached = fs.readFileSync(urlFile, 'utf8').trim();
      if (cached === fingerprint && fs.statSync(clipPath).size >= 1024) {
        this.logger.log(`[ClipCache] Shot ${shotIndex + 1} 命中缓存`);
        return clipPath;
      }
      try { fs.unlinkSync(clipPath); } catch { /* ignore */ }
      try { fs.unlinkSync(urlFile); } catch { /* ignore */ }
    }

    this.logger.log(`[ClipCache] Shot ${shotIndex + 1} 下载到缓存`);
    await this.downloader.download(videoUrl, clipPath);
    fs.writeFileSync(urlFile, fingerprint, 'utf8');
    return clipPath;
  }

  async ensureMusic(projectId: string, musicUrl: string): Promise<string> {
    const dir = this.projectDir(projectId);
    fs.mkdirSync(dir, { recursive: true });
    const musicPath = path.join(dir, 'music.cache');
    const urlFile = `${musicPath}.url`;
    const fingerprint = musicUrl;

    if (fs.existsSync(musicPath) && fs.existsSync(urlFile)) {
      const cached = fs.readFileSync(urlFile, 'utf8').trim();
      if (cached === fingerprint && fs.statSync(musicPath).size >= 1024) {
        this.logger.log('[ClipCache] 音频命中缓存');
        return musicPath;
      }
      try { fs.unlinkSync(musicPath); } catch { /* ignore */ }
      try { fs.unlinkSync(urlFile); } catch { /* ignore */ }
    }

    await this.downloader.download(musicUrl, musicPath);
    fs.writeFileSync(urlFile, fingerprint, 'utf8');
    return musicPath;
  }

  scanStats(limit = 15): WorkerClipCacheStats {
    const cacheBase = this.resolveCacheBase();
    if (!fs.existsSync(cacheBase)) {
      return { cacheBase, totalBytes: 0, projectCount: 0, fileCount: 0, topProjects: [] };
    }
    let totalBytes = 0;
    let fileCount = 0;
    const entries: WorkerClipCacheProjectSnapshot[] = [];
    for (const name of fs.readdirSync(cacheBase)) {
      const projectId = this.extractProjectId(name);
      if (!projectId) continue;
      const full = path.join(cacheBase, name);
      if (!fs.statSync(full).isDirectory()) continue;
      const scanned = this.scanDir(full);
      totalBytes += scanned.bytes;
      fileCount += scanned.fileCount;
      entries.push({
        projectId,
        bytes: scanned.bytes,
        fileCount: scanned.fileCount,
        lastAccessAt: scanned.lastAccessAt,
      });
    }
    const topProjects = entries
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, limit);
    return { cacheBase, totalBytes, projectCount: entries.length, fileCount, topProjects };
  }

  extractProjectId(dirName: string): string | null {
    if (!dirName.startsWith(PROJECT_DIR_PREFIX)) return null;
    return dirName.slice(PROJECT_DIR_PREFIX.length) || null;
  }

  cleanup(
    scope: WorkerCleanupScope,
  ): { freedBytes: number; deletedDirs: number; message: string } {
    if (scope === 'clip_cache' || scope === 'clip_cache_all') {
      return this.cleanupAllClipCache();
    }
    if (scope.startsWith('clip_cache_project:')) {
      const projectId = scope.slice('clip_cache_project:'.length);
      return this.cleanupProjectClipCache(projectId);
    }
    return { freedBytes: 0, deletedDirs: 0, message: `未知片段缓存 scope: ${scope}` };
  }

  private cleanupAllClipCache(): { freedBytes: number; deletedDirs: number; message: string } {
    const base = this.resolveCacheBase();
    if (!fs.existsSync(base)) {
      return { freedBytes: 0, deletedDirs: 0, message: '片段缓存目录不存在' };
    }
    const bytes = this.scanDir(base).bytes;
    const count = fs.readdirSync(base).filter((n) => n.startsWith(PROJECT_DIR_PREFIX)).length;
    fs.rmSync(base, { recursive: true, force: true });
    return {
      freedBytes: bytes,
      deletedDirs: count,
      message: `已清理全部片段缓存（${count} 个项目）`,
    };
  }

  private cleanupProjectClipCache(projectId: string): { freedBytes: number; deletedDirs: number; message: string } {
    const dir = this.projectDir(projectId);
    if (!fs.existsSync(dir)) {
      return { freedBytes: 0, deletedDirs: 0, message: `项目 ${projectId} 无缓存` };
    }
    const bytes = this.scanDir(dir).bytes;
    fs.rmSync(dir, { recursive: true, force: true });
    return {
      freedBytes: bytes,
      deletedDirs: 1,
      message: `已清理项目 ${projectId} 片段缓存`,
    };
  }

  private scanDir(dir: string): { bytes: number; fileCount: number; lastAccessAt: string | null } {
    let bytes = 0;
    let fileCount = 0;
    let lastMs = 0;
    const walk = (current: string) => {
      for (const name of fs.readdirSync(current)) {
        const full = path.join(current, name);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          walk(full);
          continue;
        }
        bytes += stat.size;
        fileCount++;
        const ts = Math.max(stat.mtimeMs, stat.atimeMs);
        if (ts > lastMs) lastMs = ts;
      }
    };
    walk(dir);
    return {
      bytes,
      fileCount,
      lastAccessAt: lastMs > 0 ? new Date(lastMs).toISOString() : null,
    };
  }
}
