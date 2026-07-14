/** Worker 与主服务共享的 Job 契约（手抄同步 mv-studio-api/src/compose/contracts） */

export type ComposeJobType =
  | 'compose_final'
  | 'recompose_subtitle'
  | 'render_editor'
  | 'editor_thumbnails';

export type ComposeJobStatus =
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface ComposeProgressPayload {
  stage: string;
  percent: number;
  message: string;
  queuePosition?: number;
  estimatedWaitSec?: number;
}

export interface SubtitleConfigPayload {
  [key: string]: unknown;
}

export interface WatermarkConfigPayload {
  enabled?: boolean;
  imageUrl?: string;
  scale?: number;
  opacity?: number;
  marginX?: number;
  marginY?: number;
  position?: string;
  [key: string]: unknown;
}

export interface ComposeShotPayload {
  videoUrl: string;
  duration: number;
  shotIndex: number;
  sceneId?: string;
  updatedAt?: string;
}

export interface ComposeFinalPayload {
  force?: boolean;
  shots: ComposeShotPayload[];
  musicUrl: string;
  musicDuration: number;
  musicStartTime: number;
  aspectRatio: string;
  styleTag?: string;
  lrcContent?: string;
  assContent?: string;
  subtitleConfig?: SubtitleConfigPayload | null;
  watermarkConfig?: WatermarkConfigPayload | null;
  audioOffsetMs?: number;
  audioOffsetCalibrationEnabled?: boolean;
}

export interface RecomposeSubtitlePayload {
  sourceVideoUrl: string;
  subtitleBaseUrl?: string | null;
  lrcContent: string;
  assContent?: string;
  subtitleConfig: SubtitleConfigPayload;
  aspectRatio: string;
}

export interface EditorRenderLayerPayload {
  id: string;
  type: string;
  name?: string;
  startTime?: number;
  duration?: number;
  visible?: boolean;
  opacity?: number;
  [key: string]: unknown;
}

export interface RenderEditorPayload {
  sourceVideoUrl: string;
  subtitleBaseUrl?: string | null;
  musicUrl?: string;
  musicStartTime?: number;
  editorConfig: {
    version: 1;
    layers: EditorRenderLayerPayload[];
    canvas?: { aspectRatio?: string; width?: number; height?: number };
  };
  aspectRatio: string;
  lrcContent?: string;
}

export interface EditorThumbnailShotPayload {
  shotId: string;
  shotIndex: number;
  sourceUrl: string;
  existingFrameUrls?: string[];
  existingSourceUrl?: string;
}

export interface EditorThumbnailsPayload {
  force?: boolean;
  shots: EditorThumbnailShotPayload[];
}

export type ComposeJobPayload =
  | ComposeFinalPayload
  | RecomposeSubtitlePayload
  | RenderEditorPayload
  | EditorThumbnailsPayload;

export interface UploadTargets {
  resultPutUrl: string;
  resultPublicUrl: string;
  cleanPutUrl?: string;
  cleanPublicUrl?: string;
  contentType: string;
  extraUploads?: Array<{
    key: string;
    putUrl: string;
    publicUrl: string;
    contentType: string;
  }>;
}

export interface WorkerJobDto {
  jobId: string;
  type: ComposeJobType;
  priority: number;
  projectId: string;
  userId?: string;
  projectTitle?: string;
  payload: ComposeJobPayload;
  upload: UploadTargets;
}

export interface JobCompleteOutputs {
  resultUrl: string;
  subtitleBaseUrl?: string;
  actualDurationSec?: number;
  editorConfig?: RenderEditorPayload['editorConfig'];
  shots?: Array<{ shotId: string; editorFrameUrls: string[]; editorFrameSourceUrl: string }>;
  extra?: Record<string, unknown>;
}

export type WorkerCleanupScope =
  | 'stale'
  | 'all_tmp'
  | 'clip_cache'
  | 'clip_cache_all'
  | `project:${string}`
  | `clip_cache_project:${string}`;

export interface WorkerCommandDto {
  id: string;
  type: 'cleanup_tmp';
  scope: WorkerCleanupScope;
  staleHours?: number;
}

export interface WorkerHeartbeatResponse {
  ok: boolean;
  commands?: WorkerCommandDto[];
}
