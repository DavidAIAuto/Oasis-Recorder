/**
 * Streaming WebM → MP4 (H.264 + AAC) conversion for recordings made in browsers that
 * can't record MP4 directly (e.g. Firefox) or recorded before MP4 became the default.
 *
 * Uses Mediabunny + WebCodecs (hardware encoders where available):
 *  - input is read lazily from the disk-backed OPFS File (small LRU cache, not the whole file)
 *  - output is written straight into a FileSystemWritableFileStream with positional writes
 * so memory stays flat even for multi-hour recordings (no ffmpeg.wasm).
 */

export class ConversionCancelled extends Error {
  constructor() {
    super('Conversion cancelled');
    this.name = 'ConversionCancelled';
  }
}

export interface ConvertOptions {
  /** Known duration (ms) used for progress since MediaRecorder WebM has no duration header. */
  durationMs: number;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export async function convertToMp4(input: Blob, target: FileSystemWritableFileStream, o: ConvertOptions): Promise<void> {
  const mb = await import('mediabunny'); // lazy: only loaded when a conversion is needed

  // Wrap the file stream so we keep control of it: on cancel/error the partial output
  // is discarded (abort) instead of being committed.
  let closed = false;
  const sink = new WritableStream<import('mediabunny').StreamTargetChunk>({
    write: (chunk) => target.write(chunk),
    close: async () => {
      closed = true;
      await target.close();
    },
    abort: (reason) => target.abort(reason),
  });

  const source = new mb.Input({ source: new mb.BlobSource(input), formats: mb.ALL_FORMATS });
  const output = new mb.Output({
    format: new mb.Mp4OutputFormat({ fastStart: false }), // moov at the end → no buffering of media data
    target: new mb.StreamTarget(sink, { chunked: true, chunkSize: 8 * 1024 * 1024 }),
  });

  const audioCodec = (await mb.canEncodeAudio('aac')) ? 'aac' : 'opus';

  const conversion = await mb.Conversion.init({
    input: source,
    output,
    video: { codec: 'avc', quality: mb.QUALITY_HIGH },
    audio: { codec: audioCodec, quality: mb.QUALITY_HIGH },
    showWarnings: false,
  });

  if (!conversion.isValid) {
    const reasons = conversion.discardedTracks.map((t) => `${t.track.type}: ${t.reason}`).join(', ');
    throw new Error(`This browser can't encode MP4 (${reasons || 'no usable tracks'}). Try Chrome, Edge or the desktop app.`);
  }

  const total = Math.max(1, o.durationMs / 1000);
  conversion.onProgress = (_p, processedTime) => o.onProgress?.(Math.min(0.999, processedTime / total));

  const onAbort = () => void conversion.cancel();
  o.signal?.addEventListener('abort', onAbort);
  try {
    await conversion.execute();
    o.onProgress?.(1);
  } catch (e) {
    if (!closed) await target.abort().catch(() => {});
    if (o.signal?.aborted) throw new ConversionCancelled();
    throw e;
  } finally {
    o.signal?.removeEventListener('abort', onAbort);
    source.dispose?.();
  }
}
