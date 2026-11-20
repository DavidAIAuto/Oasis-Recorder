export type ResolutionPreset = '720p' | '1080p' | 'native';
export type FpsPreset = 30 | 60;
export type ShareSurface = 'monitor' | 'window' | 'browser';

export interface RecordingSettings {
  shareSurface: ShareSurface;
  resolution: ResolutionPreset;
  fps: FpsPreset;
  systemAudio: boolean;
  micEnabled: boolean;
  micDeviceId: string | null;
  micGain: number; // 0..1.5
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  countdown: boolean;
}

export type RecordingStatus = 'recording' | 'paused' | 'completed';

export interface RecordingMeta {
  id: string;
  name: string;
  mimeType: string;
  ext: 'webm' | 'mp4';
  startTime: number; // epoch ms
  pausedDuration: number; // ms spent paused (closed pause spans)
  pausedAt: number | null; // epoch ms of current pause span start
  durationMs: number; // active recording time at last metadata write
  bytesWritten: number;
  status: RecordingStatus;
  updatedAt: number;
  hasMic: boolean;
  hasSystemAudio: boolean;
  recovered?: boolean;
}

export type EnginePhase = 'idle' | 'starting' | 'countdown' | 'recording' | 'paused' | 'stopping';

export interface QuotaInfo {
  usage: number;
  quota: number;
  available: number;
}

export interface EngineState {
  phase: EnginePhase;
  countdown: number;
  meta: RecordingMeta | null;
  bytesWritten: number;
  micMuted: boolean;
  micLive: boolean;
  quota: QuotaInfo | null;
  lowSpace: boolean;
}

export type ToastKind = 'info' | 'warning' | 'error' | 'success';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}
