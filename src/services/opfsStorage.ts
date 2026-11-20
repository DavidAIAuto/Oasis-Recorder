import type { QuotaInfo, RecordingMeta } from '../types/recording';
import { probeWebmDurationMs } from './webmDuration';

const DIR = 'recordings';

/* ------------------------------------------------------------------ */
/* Feature detection                                                   */
/* ------------------------------------------------------------------ */

export function isOpfsSupported(): boolean {
  // Note: createSyncAccessHandle() is only exposed inside workers, so it can't be
  // detected from the main thread. The storage worker reports a clear error if missing.
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.storage &&
    typeof navigator.storage.getDirectory === 'function' &&
    typeof Worker !== 'undefined' &&
    typeof FileSystemFileHandle !== 'undefined'
  );
}

/* ------------------------------------------------------------------ */
/* Storage worker client                                               */
/* ------------------------------------------------------------------ */

type Pending = { resolve: (v: { bytes: number }) => void; reject: (e: Error) => void };

class StorageWorkerClient {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();

  private get w(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('../workers/storage.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<{ reqId: number; ok: boolean; result?: { bytes: number }; error?: string }>) => {
        const p = this.pending.get(e.data.reqId);
        if (!p) return;
        this.pending.delete(e.data.reqId);
        if (e.data.ok) p.resolve(e.data.result ?? { bytes: 0 });
        else p.reject(new Error(e.data.error ?? 'Storage worker error'));
      };
      this.worker.onerror = (e) => {
        const err = new Error(e.message || 'Storage worker crashed');
        this.pending.forEach((p) => p.reject(err));
        this.pending.clear();
      };
    }
    return this.worker;
  }

  private send(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<{ bytes: number }> {
    const reqId = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
      this.w.postMessage({ ...msg, reqId }, transfer);
    });
  }

  open(id: string, ext: string) {
    return this.send({ type: 'open', id, ext });
  }
  write(id: string, data: ArrayBuffer) {
    return this.send({ type: 'write', id, data }, [data]);
  }
  meta(id: string, meta: RecordingMeta) {
    return this.send({ type: 'meta', id, json: JSON.stringify(meta) });
  }
  close(id: string) {
    return this.send({ type: 'close', id });
  }
  /** One-shot metadata write for a session that isn't open (e.g. recovery finalize). */
  async saveMeta(meta: RecordingMeta) {
    await this.open(meta.id, meta.ext);
    await this.meta(meta.id, meta);
    await this.close(meta.id);
  }
}

export const storageWorker = new StorageWorkerClient();

/* ------------------------------------------------------------------ */
/* Main-thread read / list / delete                                    */
/* ------------------------------------------------------------------ */

async function dir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR, { create: true });
}

async function readMetaFile(d: FileSystemDirectoryHandle, name: string): Promise<RecordingMeta | null> {
  try {
    const fh = await d.getFileHandle(name);
    const text = await (await fh.getFile()).text();
    if (!text.trim()) return null;
    return JSON.parse(text) as RecordingMeta;
  } catch {
    return null;
  }
}

export async function listAllMeta(): Promise<RecordingMeta[]> {
  if (!isOpfsSupported()) return [];
  const d = await dir();
  const out: RecordingMeta[] = [];
  // entries() is async iterable in all OPFS-capable browsers
  for await (const [name, handle] of (d as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
    if (handle.kind !== 'file' || !name.endsWith('.json')) continue;
    const m = await readMetaFile(d, name);
    if (m && m.id) out.push(m);
  }
  return out.sort((a, b) => b.startTime - a.startTime);
}

export async function listCompleted(): Promise<RecordingMeta[]> {
  return (await listAllMeta()).filter((m) => m.status === 'completed');
}

export async function getRecordingFile(meta: RecordingMeta): Promise<File> {
  const d = await dir();
  const fh = await d.getFileHandle(`${meta.id}.${meta.ext}`);
  return fh.getFile();
}

export async function deleteRecording(meta: Pick<RecordingMeta, 'id' | 'ext'>): Promise<void> {
  const d = await dir();
  for (const name of [`${meta.id}.${meta.ext}`, `${meta.id}.json`]) {
    try {
      await d.removeEntry(name);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'NotFoundError')) throw e;
    }
  }
}

export async function estimateQuota(): Promise<QuotaInfo | null> {
  try {
    if (!navigator.storage?.estimate) return null;
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return { usage, quota, available: Math.max(0, quota - usage) };
  } catch {
    return null;
  }
}

export async function requestPersistence(): Promise<void> {
  try {
    if (navigator.storage?.persisted && !(await navigator.storage.persisted())) {
      await navigator.storage.persist?.();
    }
  } catch {
    /* best-effort */
  }
}

/* ------------------------------------------------------------------ */
/* Locks: "is this session actively recording in some tab?"            */
/* ------------------------------------------------------------------ */

export function lockName(id: string) {
  return `recoder-rec-${id}`;
}

async function isSessionLive(meta: RecordingMeta): Promise<boolean> {
  if (navigator.locks?.request) {
    try {
      return await navigator.locks.request(lockName(meta.id), { ifAvailable: true }, (lock) => lock === null);
    } catch {
      /* fall through */
    }
  }
  // Fallback heuristic: metadata updated in the last 15 seconds → probably still live.
  return Date.now() - meta.updatedAt < 15_000;
}

/** Hold a Web Lock for the whole lifetime of a recording. Returns a release function. */
export function holdSessionLock(id: string): () => void {
  if (!navigator.locks?.request) return () => {};
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  navigator.locks.request(lockName(id), () => held).catch(() => {});
  return release;
}

/* ------------------------------------------------------------------ */
/* Crash recovery                                                      */
/* ------------------------------------------------------------------ */

export interface InterruptedSession {
  meta: RecordingMeta;
  fileSize: number;
}

export async function findInterrupted(): Promise<InterruptedSession[]> {
  if (!isOpfsSupported()) return [];
  const all = await listAllMeta();
  const out: InterruptedSession[] = [];
  for (const m of all) {
    if (m.status === 'completed') continue;
    if (await isSessionLive(m)) continue;
    let fileSize = 0;
    try {
      fileSize = (await getRecordingFile(m)).size;
    } catch {
      /* video file missing */
    }
    out.push({ meta: m, fileSize });
  }
  return out;
}

export async function finalizeInterrupted(s: InterruptedSession): Promise<RecordingMeta> {
  const { meta } = s;
  let durationMs = meta.durationMs;
  try {
    const file = await getRecordingFile(meta);
    let probed: number | null = null;
    if (meta.ext === 'webm') probed = await probeWebmDurationMs(file);
    if (probed && probed > 0) {
      durationMs = probed;
    } else if (meta.bytesWritten > 0 && meta.durationMs > 0 && file.size > meta.bytesWritten) {
      // Extrapolate from average bitrate up to the last metadata write.
      durationMs = Math.round(meta.durationMs * (file.size / meta.bytesWritten));
    }
    const finalized: RecordingMeta = {
      ...meta,
      durationMs,
      bytesWritten: file.size,
      status: 'completed',
      pausedAt: null,
      recovered: true,
      updatedAt: Date.now(),
    };
    await storageWorker.saveMeta(finalized);
    return finalized;
  } catch (e) {
    throw new Error(`Could not finalize recording: ${(e as Error).message}`);
  }
}
