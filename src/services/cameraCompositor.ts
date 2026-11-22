import type { BubbleCorner, BubbleSize } from '../types/recording';
import type { CompositorMsg } from '../workers/compositor.worker';

/** Burn-into-video needs insertable streams + OffscreenCanvas (Chrome/Edge 94+, Electron). */
export const isCompositorSupported = () =>
  typeof MediaStreamTrackProcessor !== 'undefined' &&
  typeof MediaStreamTrackGenerator !== 'undefined' &&
  typeof OffscreenCanvas !== 'undefined' &&
  typeof VideoFrame !== 'undefined';

export interface CompositorOptions {
  fps: number;
  size: BubbleSize;
  corner: BubbleCorner;
  onCameraEnded: () => void;
  onError: (message: string) => void;
}

/**
 * Screen + round camera bubble → one video track, composited in a worker.
 * The camera track is borrowed: the compositor reads from a clone and stops only the clone.
 */
export class CameraCompositor {
  readonly track: MediaStreamTrack;
  private worker: Worker;
  private cameraClone: MediaStreamVideoTrack;
  private disposed = false;

  // Types for MediaStreamTrackProcessor/Generator come from @types/dom-mediacapture-transform.
  constructor(screenTrack: MediaStreamTrack, cameraTrack: MediaStreamTrack, o: CompositorOptions) {
    this.cameraClone = (cameraTrack as MediaStreamVideoTrack).clone();
    const screen = new MediaStreamTrackProcessor({ track: screenTrack as MediaStreamVideoTrack, maxBufferSize: 2 }).readable;
    const camera = new MediaStreamTrackProcessor({ track: this.cameraClone, maxBufferSize: 2 }).readable;
    const generator = new MediaStreamTrackGenerator({ kind: 'video' });
    this.track = generator;

    this.worker = new Worker(new URL('../workers/compositor.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<{ type: string; message?: string }>) => {
      if (this.disposed) return;
      if (e.data.type === 'camera-ended') o.onCameraEnded();
      else if (e.data.type === 'error') o.onError(e.data.message ?? 'unknown error');
    };
    this.worker.onerror = (e) => {
      if (!this.disposed) o.onError(e.message || 'Camera compositor crashed');
    };
    this.post(
      { type: 'init', screen, camera, out: generator.writable, fps: o.fps, size: o.size, corner: o.corner },
      [screen, camera, generator.writable],
    );
  }

  private post(m: CompositorMsg, transfer: Transferable[] = []) {
    this.worker.postMessage(m, transfer);
  }

  setVisible(visible: boolean) {
    this.post({ type: 'visible', visible });
  }

  dispose() {
    if (this.disposed) return;
    // Detach first: stopping the tracks below makes the worker report "camera ended" /
    // write errors, which are expected here and must not surface as toasts.
    this.disposed = true;
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.post({ type: 'stop' });
    // Give the worker a moment to close its frames/readers before it is torn down.
    const w = this.worker;
    window.setTimeout(() => w.terminate(), 500);
    this.cameraClone.stop();
    this.track.stop();
  }
}
