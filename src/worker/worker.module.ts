import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { MainApiClient } from '../api-client/main-api.client';
import { DownloaderService, UploaderService } from '../storage/storage.service';
import { ComposeHandler } from '../handlers/compose.handler';
import { SubtitleHandler } from '../handlers/subtitle.handler';
import { EditorHandler } from '../handlers/editor.handler';
import { EditorThumbnailsHandler } from '../handlers/editor-thumbnails.handler';
import { JobRunnerService } from './job-runner.service';
import { PollerService } from './poller.service';

@Module({
  imports: [HttpModule.register({ timeout: 120_000 })],
  providers: [
    MainApiClient,
    DownloaderService,
    UploaderService,
    ComposeHandler,
    SubtitleHandler,
    EditorHandler,
    EditorThumbnailsHandler,
    JobRunnerService,
    PollerService,
  ],
})
export class WorkerModule {}
