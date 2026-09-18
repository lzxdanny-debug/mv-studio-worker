import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';

@Injectable()
export class DownloaderService {
  private readonly logger = new Logger(DownloaderService.name);

  async download(url: string, destPath: string, timeoutMs = 120_000): Promise<void> {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const partialPath = `${destPath}.part`;
    const maxAttempts = 4;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        fs.rmSync(partialPath, { force: true });
        const res = await axios.get(url, {
          responseType: 'stream',
          timeout: timeoutMs,
          maxRedirects: 5,
        });
        await pipeline(res.data, createWriteStream(partialPath, { flags: 'wx' }));
        const stat = fs.statSync(partialPath);
        if (stat.size < 1024) {
          throw new Error(`下载文件过小: ${partialPath} (${stat.size} bytes)`);
        }
        fs.renameSync(partialPath, destPath);
        this.logger.debug(`已下载 ${url.slice(0, 80)}... → ${destPath}`);
        return;
      } catch (error) {
        lastError = error;
        fs.rmSync(partialPath, { force: true });
        if (attempt >= maxAttempts) break;
        const delayMs = 500 * 2 ** (attempt - 1);
        this.logger.warn(
          `下载失败，${delayMs}ms 后重试（${attempt}/${maxAttempts - 1}）: ${error instanceof Error ? error.message : error}`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? '下载失败'));
  }
}

@Injectable()
export class UploaderService {
  private readonly logger = new Logger(UploaderService.name);

  async uploadPresigned(localPath: string, putUrl: string, contentType: string): Promise<void> {
    const body = fs.readFileSync(localPath);
    await axios.put(putUrl, body, {
      headers: { 'Content-Type': contentType },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 600_000,
    });
    this.logger.debug(`已上传 ${localPath} (${body.length} bytes)`);
  }
}
