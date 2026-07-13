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
    const res = await axios.get(url, {
      responseType: 'stream',
      timeout: timeoutMs,
      maxRedirects: 5,
    });
    await pipeline(res.data, createWriteStream(destPath));
    const stat = fs.statSync(destPath);
    if (stat.size < 1024) {
      throw new Error(`下载文件过小: ${destPath} (${stat.size} bytes)`);
    }
    this.logger.debug(`已下载 ${url.slice(0, 80)}... → ${destPath}`);
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
