import type { FpsPreset, RecordingSettings, ResolutionPreset } from '../types/recording';
import { native } from '../lib/platform';

export const hasDisplayMedia = () =>
  typeof navigator !== 'undefined' && !!navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function';

export const hasMediaRecorder = () => typeof window !== 'undefined' && typeof window.MediaRecorder === 'function';

const RES: Record<Exclude<ResolutionPreset, 'native'>, { width: number; height: number }> = {
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
};

/** Ask the user to pick a screen / window / tab. Throws on denial. */
export async function getDisplayStream(
  settings: Pick<RecordingSettings, 'resolution' | 'fps' | 'systemAudio' | 'shareSurface'>,
): Promise<MediaStream> {
  // In the desktop app the main process shows its own picker; tell it which tab to open on.
  native?.setSharePreference(settings.shareSurface, settings.systemAudio);
  const video: MediaTrackConstraints & { displaySurface?: string } = {
    frameRate: { ideal: settings.fps, max: settings.fps },
    // Pre-selects the matching pane (Screen / Window / Tab) in Chrome & Edge's picker.
    displaySurface: settings.shareSurface,
  };
  if (settings.resolution !== 'native') {
    // `max` lets the browser downscale while keeping the source aspect ratio.
    video.width = { max: RES[settings.resolution].width };
    video.height = { max: RES[settings.resolution].height };
  }
  const audio: boolean | MediaTrackConstraints = settings.systemAudio
    ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    : false;

  // Chrome-only hints are passed through; other browsers ignore unknown keys.
  const options = {
    video,
    audio,
    selfBrowserSurface: 'exclude',
    monitorTypeSurfaces: 'include',
    surfaceSwitching: 'include',
    systemAudio: settings.systemAudio ? 'include' : 'exclude',
  } as DisplayMediaStreamOptions;

  try {
    return await navigator.mediaDevices.getDisplayMedia(options);
  } catch (e) {
    // Desktop app: if system-audio capture isn't available on this Mac, retry the same
    // source (no second picker) with video only rather than failing the whole recording.
    const name = (e as DOMException)?.name;
    if (native && settings.systemAudio && name !== 'NotAllowedError') {
      native.reuseLastChoiceWithoutAudio();
      return navigator.mediaDevices.getDisplayMedia({ ...options, audio: false });
    }
    throw e;
  }
}

export interface MicOptions {
  deviceId: string | null;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

export async function getMicStream(o: MicOptions): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: o.deviceId ? { exact: o.deviceId } : undefined,
      echoCancellation: o.echoCancellation,
      noiseSuppression: o.noiseSuppression,
      autoGainControl: o.autoGainControl,
      channelCount: { ideal: 1 },
    },
    video: false,
  });
}

export async function listMics(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === 'audioinput');
}

// MP4 (H.264 + AAC) first: plays everywhere (QuickTime, iPhone, editors) and needs no
// conversion on export. Chrome/Edge 126+, Safari and the desktop app support it; Firefox
// falls back to WebM, which is converted to MP4 when saving.
const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4;codecs=avc1,opus',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export function pickMimeType(): { mimeType: string; ext: 'webm' | 'mp4' } | null {
  if (!hasMediaRecorder()) return null;
  for (const m of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return { mimeType: m, ext: m.startsWith('video/mp4') ? 'mp4' : 'webm' };
    } catch {
      /* ignore */
    }
  }
  return null;
}

export const AUDIO_BPS = 128_000;

export function videoBitrateFor(res: ResolutionPreset, fps: FpsPreset): number {
  const base = res === '720p' ? 2_500_000 : res === '1080p' ? 5_000_000 : 8_000_000;
  return fps === 60 ? Math.round(base * 1.5) : base;
}

export function estimateMBPerHour(res: ResolutionPreset, fps: FpsPreset, withAudio: boolean): number {
  const bps = videoBitrateFor(res, fps) + (withAudio ? AUDIO_BPS : 0);
  return (bps * 3600) / 8 / 1_000_000;
}

export function stopStream(s: MediaStream | null | undefined) {
  s?.getTracks().forEach((t) => {
    try {
      t.stop();
    } catch {
      /* ignore */
    }
  });
}

/** Turn a getUserMedia/getDisplayMedia error into a friendly message. */
export function describeMediaError(e: unknown, source: 'screen' | 'microphone'): string {
  const name = e instanceof DOMException ? e.name : (e as Error)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return source === 'screen'
      ? 'Screen sharing was blocked or cancelled. Click "Start Recording" again and pick a screen, window or tab. If no prompt appears, allow screen recording for your browser in System Settings → Privacy & Security → Screen Recording, then restart the browser.'
      : 'Microphone access was denied. Click the lock/site-settings icon in the address bar, set Microphone to "Allow", then reload — or turn the mic off to record without it.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return source === 'screen'
      ? 'No screen source is available to capture.'
      : 'The selected microphone could not be found. Pick another one or click Refresh.';
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return source === 'screen'
      ? 'The browser could not start screen capture (the source may be in use or protected).'
      : 'The microphone is in use by another application or could not be opened.';
  }
  return `${source === 'screen' ? 'Screen capture' : 'Microphone'} error: ${(e as Error)?.message ?? String(e)}`;
}
