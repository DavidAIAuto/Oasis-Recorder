import type { EngineState, RecordingMeta, RecordingSettings, ToastKind } from '../types/recording';
import { AudioMixer } from './audioMixer';
import { CameraCompositor, isCompositorSupported } from './cameraCompositor';
import {
  AUDIO_BPS,
  describeMediaError,
  getDisplayStream,
  hasDisplayMedia,
  pickMimeType,
  stopStream,
  videoBitrateFor,
} from './mediaCapture';
import { deleteRecording, estimateQuota, holdSessionLock, isOpfsSupported, requestPersistence, storageWorker } from './opfsStorage';

export const MIN_FREE_BYTES = 250 * 1024 * 1024;
const WARN_FREE_BYTES = 1024 * 1024 * 1024;
const META_INTERVAL_MS = 5_000;
const QUOTA_INTERVAL_MS = 30_000;

/** Active (non-paused) recording time in ms. */
export function activeElapsedMs(meta: RecordingMeta | null, now = Date.now()): number {
  if (!meta) return 0;
  if (meta.status === 'completed') return meta.durationMs;
  const pausedSpan = meta.pausedAt ? now - meta.pausedAt : 0;
  return Math.max(0, now - meta.startTime - meta.pausedDuration - pausedSpan);
}

type EngineEvent =
  | { type: 'toast'; kind: ToastKind; message: string }
  | { type: 'finished'; meta: RecordingMeta };

const INITIAL: EngineState = {
  phase: 'idle',
  countdown: 0,
  meta: null,
  bytesWritten: 0,
  micMuted: false,
  micLive: false,
  cameraLive: false,
  cameraHidden: false,
  quota: null,
  lowSpace: false,
};

export class RecorderEngine {
  private state: EngineState = INITIAL;
  private listeners = new Set<() => void>();
  private eventListeners = new Set<(e: EngineEvent) => void>();

  private display: MediaStream | null = null;
  private mixer: AudioMixer | null = null;
  private recorder: MediaRecorder | null = null;
  private meta: RecordingMeta | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private writeFailed = false;
  private releaseLock: (() => void) | null = null;
  private timers: number[] = [];
  private countdownCancel: (() => void) | null = null;
  private bytesAtQuotaCheck = 0;
  private micTrackCleanup: (() => void) | null = null;
  private compositor: CameraCompositor | null = null;

  /* ---------------- store plumbing (useSyncExternalStore) ---------------- */
  getState = () => this.state;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  onEvent(fn: (e: EngineEvent) => void) {
    this.eventListeners.add(fn);
    return () => {
      this.eventListeners.delete(fn);
    };
  }
  private set(patch: Partial<EngineState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }
  private emit(e: EngineEvent) {
    this.eventListeners.forEach((l) => l(e));
  }
  private toast(kind: ToastKind, message: string) {
    this.emit({ type: 'toast', kind, message });
  }

  get analyser(): AnalyserNode | null {
    return this.mixer?.hasMic ? this.mixer.analyser : null;
  }

  /* ------------------------------- start ------------------------------- */

  /**
   * Start a recording. `micStream` and `cameraStream` are owned by the caller (the setup
   * preview) and are NOT stopped by the engine. The camera is only used here in
   * composite mode; the floating bubble is captured as part of the screen. Throws an Error with a user-friendly message on failure;
   * no OPFS files are created unless capture permissions were granted.
   */
  async start(settings: RecordingSettings, micStream: MediaStream | null, cameraStream: MediaStream | null = null): Promise<void> {
    if (this.state.phase !== 'idle') return;

    if (!isOpfsSupported()) throw new Error('This browser does not support the Origin Private File System, which is required for unlimited disk-streamed recording. Please use a recent Chrome, Edge, Firefox or Safari.');
    if (!hasDisplayMedia()) throw new Error('Screen capture is not supported in this browser (getDisplayMedia is unavailable). Desktop Chrome, Edge, Firefox or Safari are required.');
    const mime = pickMimeType();
    if (!mime) throw new Error('MediaRecorder is not available or supports no usable video format in this browser.');

    this.set({ ...INITIAL, phase: 'starting' });

    try {
      const quota = await estimateQuota();
      if (quota && quota.quota > 0 && quota.available < MIN_FREE_BYTES) {
        throw new Error(`Not enough free storage to start recording (${(quota.available / 1e6).toFixed(0)} MB available, at least 250 MB required). Delete old recordings to free space.`);
      }
      this.set({ quota, lowSpace: !!quota && quota.available < WARN_FREE_BYTES });
      void requestPersistence();

      try {
        this.display = await getDisplayStream(settings);
      } catch (e) {
        throw new Error(describeMediaError(e, 'screen'));
      }

      const videoTrack = this.display.getVideoTracks()[0];
      if (!videoTrack) throw new Error('The selected source provided no video.');

      if (settings.systemAudio && this.display.getAudioTracks().length === 0) {
        this.toast('info', 'No system audio was shared. In Chrome/Edge, tick "Share audio" in the picker (on macOS only browser-tab audio is available).');
      }

      // Audio graph
      const micUsable = settings.micEnabled && micStream && micStream.getAudioTracks().some((t) => t.readyState === 'live');
      const wantsAudio = micUsable || this.display.getAudioTracks().length > 0;
      if (wantsAudio) {
        this.mixer = new AudioMixer();
        await this.mixer.resume();
        if (micUsable) {
          this.mixer.setMic(micStream);
          this.mixer.setMicGain(settings.micGain);
          this.watchMicTrack(micStream!);
        }
        this.mixer.setSystem(this.display);
      }

      // If the user hits the browser's "Stop sharing" during countdown or recording.
      videoTrack.addEventListener('ended', this.handleShareEnded);

      // Optional countdown (after source selection, like Loom).
      if (settings.countdown) {
        const proceed = await this.runCountdown(3);
        if (!proceed) {
          this.teardown();
          this.set({ ...INITIAL });
          return;
        }
      }

      // Composite mode: record screen + camera bubble drawn together in a worker.
      let recordedVideo: MediaStreamTrack = videoTrack;
      const cameraTrack = cameraStream?.getVideoTracks().find((t) => t.readyState === 'live');
      if (settings.cameraEnabled && settings.cameraMode === 'composite' && cameraTrack) {
        if (isCompositorSupported()) {
          this.compositor = new CameraCompositor(videoTrack, cameraTrack, {
            fps: settings.fps,
            size: settings.bubbleSize,
            corner: settings.bubbleCorner,
            onCameraEnded: () => {
              if (!this.state.cameraLive) return;
              this.set({ cameraLive: false });
              this.toast('warning', 'Camera disconnected. Recording continues without the camera bubble.');
            },
            onError: (msg) => {
              this.toast('error', `Camera bubble error: ${msg}. Saving what was recorded.`);
              void this.stop();
            },
          });
          recordedVideo = this.compositor.track;
        } else {
          this.toast('warning', 'This browser cannot burn the camera into the video — recording the screen only.');
        }
      }

      const tracks = [recordedVideo, ...(this.mixer ? this.mixer.audioTracks : [])];
      const combined = new MediaStream(tracks);
      const recorder = new MediaRecorder(combined, {
        mimeType: mime.mimeType,
        videoBitsPerSecond: videoBitrateFor(settings.resolution, settings.fps),
        audioBitsPerSecond: this.mixer ? AUDIO_BPS : undefined,
        // Keyframe every second: Chrome's MP4 muxer only emits a fragment at keyframes, so this
        // keeps data flowing to disk ~every second instead of buffering it in memory.
        videoKeyFrameIntervalDuration: 1000,
      } as MediaRecorderOptions);

      // Only now (permissions granted, user didn't cancel) do we create files on disk.
      const id = (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^a-z0-9-]/gi, '');
      const now = Date.now();
      this.meta = {
        id,
        name: new Date(now).toLocaleString(),
        mimeType: recorder.mimeType || mime.mimeType,
        ext: mime.ext,
        startTime: now,
        pausedDuration: 0,
        pausedAt: null,
        durationMs: 0,
        bytesWritten: 0,
        status: 'recording',
        updatedAt: now,
        hasMic: !!micUsable,
        hasSystemAudio: !!this.mixer?.hasSystem,
        hasCamera: !!this.compositor,
      };
      this.releaseLock = holdSessionLock(id);
      await storageWorker.open(id, mime.ext);
      await storageWorker.meta(id, this.meta);

      this.writeChain = Promise.resolve();
      this.writeFailed = false;
      this.bytesAtQuotaCheck = 0;
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) this.enqueue(e.data);
      };
      recorder.onerror = (e) => {
        const err = (e as unknown as { error?: DOMException }).error;
        this.toast('error', `Recorder error: ${err?.message ?? 'unknown'}. Saving what was recorded.`);
        void this.stop();
      };
      recorder.onstop = () => void this.finalize();
      this.recorder = recorder;

      recorder.start(1000);
      this.meta.startTime = Date.now();
      this.set({ phase: 'recording', meta: { ...this.meta }, micLive: !!micUsable, micMuted: false, cameraLive: !!this.compositor, cameraHidden: false });

      this.timers.push(window.setInterval(() => void this.persistMeta(), META_INTERVAL_MS));
      this.timers.push(window.setInterval(() => void this.checkQuota(), QUOTA_INTERVAL_MS));
    } catch (e) {
      this.teardown();
      if (this.meta) {
        // Files were created but recording never started → remove them to avoid orphans.
        const m = this.meta;
        this.meta = null;
        try {
          await storageWorker.close(m.id);
          await deleteRecording(m);
        } catch {
          /* ignore */
        }
      }
      this.set({ ...INITIAL });
      throw e instanceof Error ? e : new Error(String(e));
    }
  }

  private runCountdown(seconds: number): Promise<boolean> {
    return new Promise((resolve) => {
      let n = seconds;
      this.set({ phase: 'countdown', countdown: n });
      const t = window.setInterval(() => {
        n -= 1;
        if (n <= 0) {
          window.clearInterval(t);
          this.countdownCancel = null;
          resolve(true);
        } else {
          this.set({ countdown: n });
        }
      }, 1000);
      this.countdownCancel = () => {
        window.clearInterval(t);
        this.countdownCancel = null;
        resolve(false);
      };
    });
  }

  private watchMicTrack(stream: MediaStream) {
    const track = stream.getAudioTracks()[0];
    if (!track) return;
    const onEnded = () => {
      this.set({ micLive: false });
      this.toast('warning', 'Microphone disconnected. Recording continues with screen and system audio.');
    };
    track.addEventListener('ended', onEnded);
    this.micTrackCleanup = () => track.removeEventListener('ended', onEnded);
  }

  private handleShareEnded = () => {
    if (this.state.phase === 'countdown') {
      this.countdownCancel?.();
      return;
    }
    if (this.state.phase === 'recording' || this.state.phase === 'paused') {
      this.toast('info', 'Screen sharing ended — saving your recording.');
      void this.stop();
    }
  };

  /* --------------------------- disk streaming --------------------------- */

  private enqueue(blob: Blob) {
    const meta = this.meta;
    if (!meta) return;
    this.writeChain = this.writeChain.then(async () => {
      if (this.writeFailed) return;
      try {
        const buf = await blob.arrayBuffer();
        const { bytes } = await storageWorker.write(meta.id, buf);
        meta.bytesWritten = bytes;
        this.set({ bytesWritten: bytes });
        this.checkLocalSpace();
      } catch (e) {
        this.writeFailed = true;
        this.toast('error', `Writing to disk failed (${(e as Error).message}). Stopping and keeping what was saved.`);
        void this.stop();
      }
    });
  }

  private checkLocalSpace() {
    const q = this.state.quota;
    if (!q || q.quota <= 0) return;
    const remaining = q.available - (this.state.bytesWritten - this.bytesAtQuotaCheck);
    if (remaining < MIN_FREE_BYTES && (this.state.phase === 'recording' || this.state.phase === 'paused')) {
      this.toast('error', 'Storage almost full (< 250 MB left). Recording was stopped and saved automatically.');
      void this.stop();
    } else if (remaining < WARN_FREE_BYTES && !this.state.lowSpace) {
      this.set({ lowSpace: true });
      this.toast('warning', 'Less than 1 GB of browser storage left. The recording will auto-stop before space runs out.');
    }
  }

  private async checkQuota() {
    const q = await estimateQuota();
    if (!q) return;
    this.bytesAtQuotaCheck = this.state.bytesWritten;
    this.set({ quota: q });
    this.checkLocalSpace();
  }

  private async persistMeta() {
    const m = this.meta;
    if (!m || this.finalizing) return;
    m.durationMs = activeElapsedMs(m);
    m.updatedAt = Date.now();
    // Serialize behind chunk writes so bytesWritten is consistent with the file.
    const snapshot = { ...m };
    this.writeChain = this.writeChain.then(() => storageWorker.meta(m.id, snapshot).then(() => undefined, () => undefined));
    await this.writeChain;
  }

  /* --------------------------- controls --------------------------- */

  pause() {
    if (this.state.phase !== 'recording' || !this.recorder || !this.meta) return;
    try {
      this.recorder.pause();
    } catch {
      return;
    }
    this.meta.pausedAt = Date.now();
    this.meta.status = 'paused';
    this.set({ phase: 'paused', meta: { ...this.meta } });
    void this.persistMeta();
  }

  resume() {
    if (this.state.phase !== 'paused' || !this.recorder || !this.meta) return;
    try {
      this.recorder.resume();
    } catch {
      return;
    }
    if (this.meta.pausedAt) this.meta.pausedDuration += Date.now() - this.meta.pausedAt;
    this.meta.pausedAt = null;
    this.meta.status = 'recording';
    this.set({ phase: 'recording', meta: { ...this.meta } });
    void this.persistMeta();
  }

  setMuted(muted: boolean) {
    if (!this.mixer?.hasMic) return;
    this.mixer.setMuted(muted);
    this.set({ micMuted: muted });
  }

  toggleMute() {
    this.setMuted(!this.state.micMuted);
  }

  /** Composite mode only: hide/show the burned-in camera bubble without stopping anything. */
  setCameraHidden(hidden: boolean) {
    if (!this.compositor) return;
    this.compositor.setVisible(!hidden);
    this.set({ cameraHidden: hidden });
  }

  setMicGain(gain: number) {
    this.mixer?.setMicGain(gain);
  }

  async stop(): Promise<void> {
    const phase = this.state.phase;
    if (phase === 'countdown') {
      this.countdownCancel?.();
      return;
    }
    if (phase !== 'recording' && phase !== 'paused') return;
    if (this.meta?.pausedAt) {
      this.meta.pausedDuration += Date.now() - this.meta.pausedAt;
      this.meta.pausedAt = null;
    }
    this.set({ phase: 'stopping' });
    const r = this.recorder;
    if (r && r.state !== 'inactive') {
      try {
        r.stop(); // → final dataavailable → onstop → finalize()
        return;
      } catch {
        /* fall through */
      }
    }
    await this.finalize();
  }

  private finalizing = false;
  private async finalize() {
    if (this.finalizing || !this.meta) return;
    this.finalizing = true;
    this.timers.forEach((t) => window.clearInterval(t));
    this.timers = [];
    const m = this.meta;
    try {
      // Wait for every queued chunk to hit disk.
      await this.writeChain;
      m.durationMs = activeElapsedMs({ ...m, status: 'recording' });
      m.status = 'completed';
      m.pausedAt = null;
      m.updatedAt = Date.now();
      await storageWorker.meta(m.id, m);
      await storageWorker.close(m.id);
      this.emit({ type: 'finished', meta: { ...m } });
      this.toast('success', 'Recording saved to your local library.');
    } catch (e) {
      this.toast('error', `Failed to finalize recording: ${(e as Error).message}. It will be offered for recovery on next load.`);
    } finally {
      this.teardown();
      this.meta = null;
      this.finalizing = false;
      this.set({ ...INITIAL, quota: this.state.quota });
    }
  }

  private teardown() {
    this.timers.forEach((t) => window.clearInterval(t));
    this.timers = [];
    this.countdownCancel = null;
    this.display?.getVideoTracks().forEach((t) => t.removeEventListener('ended', this.handleShareEnded));
    stopStream(this.display);
    this.display = null;
    this.micTrackCleanup?.();
    this.micTrackCleanup = null;
    this.compositor?.dispose();
    this.compositor = null;
    this.mixer?.dispose();
    this.mixer = null;
    if (this.recorder) {
      this.recorder.ondataavailable = null;
      this.recorder.onstop = null;
      this.recorder.onerror = null;
    }
    this.recorder = null;
    this.releaseLock?.();
    this.releaseLock = null;
  }
}

export const recorderEngine = new RecorderEngine();
