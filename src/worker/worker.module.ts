import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { MainApiClient } from '../api-client/main-api.client';
import { DownloaderService, UploaderService } from '../storage/storage.service';
import { ClipCacheService } from '../storage/clip-cache.service';
import { ComposeHandler } from '../handlers/compose.handler';
import { SubtitleHandler } from '../handlers/subtitle.handler';
import { EditorHandler } from '../handlers/editor.handler';
import { EditorThumbnailsHandler } from '../handlers/editor-thumbnails.handler';
import { JobRunnerService } from './job-runner.service';
import { PollerService } from './poller.service';
import { TmpCleanupService } from './tmp-cleanup.service';
import { LyricsV2RendererService } from '../rendering/lyrics-v2-renderer.service';

@Module({
  imports: [HttpModule.register({ timeout: 120_000 })],
  providers: [
    MainApiClient,
    DownloaderService,
    UploaderService,
    ClipCacheService,
    LyricsV2RendererService,
    ComposeHandler,
    SubtitleHandler,
    EditorHandler,
    EditorThumbnailsHandler,
    JobRunnerService,
    TmpCleanupService,
    PollerService,
  ],
})
export class WorkerModule {}
