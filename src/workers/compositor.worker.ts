/**
 * Camera compositor worker ("burn into video" camera bubble).
 *
 * Reads VideoFrames from the screen and camera tracks (MediaStreamTrackProcessor
 * readables transferred from the page), draws the screen with a round camera bubble
 * on an OffscreenCanvas and writes the result into a MediaStreamTrackGenerator.
 *
 * Only the latest frame of each source is kept; every superseded frame is closed at
 * once, otherwise the capture frame pools run dry and the sources stall. Running in a
 * worker keeps compositing alive while the page is in a hidden/background tab.
 */
import type { BubbleCorner, BubbleSize } from '../types/recording';

export type CompositorMsg =
  | {
      type: 'init';
      screen: ReadableStream<VideoFrame>;
      camera: ReadableStream<VideoFrame>;
      out: WritableStream<VideoFrame>;
      fps: number;
      size: BubbleSize;
      corner: BubbleCorner;
    }
  | { type: 'visible'; visible: boolean }
  | { type: 'stop' };

/** Bubble diameter as a fraction of the output height. */
const DIAMETER: Record<BubbleSize, number> = { S: 0.18, M: 0.24, L: 0.32 };

let screen: VideoFrame | null = null;
let camera: VideoFrame | null = null;
let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let writer: WritableStreamDefaultWriter<VideoFrame> | null = null;
let readers: ReadableStreamDefaultReader<VideoFrame>[] = [];
let visible = true;
let stopped = false;
let writing = false;
let minGapUs = 1e6 / 30;
let lastTs = -Infinity;
let size: BubbleSize = 'M';
let corner: BubbleCorner = 'bl';

const post = (m: unknown) => (self as unknown as Worker).postMessage(m);

function even(n: number) {
  return Math.max(2, Math.round(n / 2) * 2);
}

function draw(c: OffscreenCanvas, g: OffscreenCanvasRenderingContext2D, s: VideoFrame) {
  const W = c.width;
  const H = c.height;
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);

  // Screen, letterboxed into the fixed output size (the source may be resized mid-recording).
  const sw = s.displayWidth;
  const sh = s.displayHeight;
  const k = Math.min(W / sw, H / sh);
  const dw = sw * k;
  const dh = sh * k;
  g.drawImage(s, (W - dw) / 2, (H - dh) / 2, dw, dh);

  if (!camera || !visible) return;
  const d = Math.round(H * DIAMETER[size]);
  const margin = Math.round(H * 0.025);
  const x = corner.endsWith('l') ? margin : W - margin - d;
  const y = corner.startsWith('t') ? margin : H - margin - d;
  const cw = camera.displayWidth;
  const ch = camera.displayHeight;
  const side = Math.min(cw, ch);

  g.save();
  g.beginPath();
  g.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2);
  g.clip();
  // Mirrored, centre-cropped to a square ("selfie" view).
  g.translate(x + d, y);
  g.scale(-1, 1);
  g.drawImage(camera, (cw - side) / 2, (ch - side) / 2, side, side, 0, 0, d, d);
  g.restore();

  g.beginPath();
  g.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2);
  g.lineWidth = Math.max(2, Math.round(d * 0.015));
  g.strokeStyle = 'rgba(255,255,255,0.85)';
  g.stroke();
}

async function render() {
  if (stopped || writing || !screen || !writer) return;
  const now = performance.now() * 1000;
  if (now - lastTs < minGapUs * 0.9) return; // cap at the target fps
  if (!canvas) {
    canvas = new OffscreenCanvas(even(screen.displayWidth), even(screen.displayHeight));
    ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!ctx) {
      post({ type: 'error', message: 'Could not create a 2D canvas for the camera bubble.' });
      return;
    }
  }
  lastTs = now;
  writing = true;
  let frame: VideoFrame | null = null;
  try {
    draw(canvas, ctx!, screen);
    frame = new VideoFrame(canvas, { timestamp: Math.round(now) });
    await writer.write(frame);
  } catch (e) {
    if (!stopped) post({ type: 'error', message: (e as Error).message });
  } finally {
    frame?.close();
    writing = false;
  }
}

async function pump(stream: ReadableStream<VideoFrame>, onFrame: (f: VideoFrame) => void, onEnd: () => void) {
  const reader = stream.getReader();
  readers.push(reader);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done || stopped) {
        value?.close();
        break;
      }
      onFrame(value);
    }
  } catch {
    /* source errored or was cancelled */
  }
  onEnd();
}

function stop() {
  if (stopped) return;
  stopped = true;
  readers.forEach((r) => void r.cancel().catch(() => {}));
  readers = [];
  screen?.close();
  camera?.close();
  screen = camera = null;
  void writer?.close().catch(() => {});
  writer = null;
}

self.onmessage = (e: MessageEvent<CompositorMsg>) => {
  const m = e.data;
  if (m.type === 'init') {
    minGapUs = 1e6 / m.fps;
    size = m.size;
    corner = m.corner;
    writer = m.out.getWriter();
    void pump(
      m.screen,
      (f) => {
        screen?.close();
        screen = f;
        void render();
      },
      () => {
        stop();
        post({ type: 'ended' });
      },
    );
    void pump(
      m.camera,
      (f) => {
        camera?.close();
        camera = f;
        void render();
      },
      () => {
        // Camera unplugged: keep recording the screen without the bubble.
        camera?.close();
        camera = null;
        if (!stopped) post({ type: 'camera-ended' });
      },
    );
  } else if (m.type === 'visible') {
    visible = m.visible;
    void render();
  } else if (m.type === 'stop') {
    stop();
  }
};
