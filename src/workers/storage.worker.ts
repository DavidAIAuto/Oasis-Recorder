/**
 * Dedicated storage worker.
 *
 * Uses FileSystemSyncAccessHandle which writes *in place* (unlike createWritable(),
 * which writes to a swap file only committed on close()). Every chunk is flushed,
 * so a tab crash leaves everything up to the last chunk durable on disk.
 *
 * Messages are processed strictly in order through a promise chain → serial write queue.
 */

interface SyncHandle {
  write(buffer: ArrayBufferView | ArrayBuffer, opts?: { at?: number }): number;
  truncate(size: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

type Req =
  | { reqId: number; type: 'open'; id: string; ext: string }
  | { reqId: number; type: 'write'; id: string; data: ArrayBuffer }
  | { reqId: number; type: 'meta'; id: string; json: string }
  | { reqId: number; type: 'close'; id: string };

interface Session {
  video: SyncHandle;
  meta: SyncHandle;
  offset: number;
}

const sessions = new Map<string, Session>();
const encoder = new TextEncoder();
let queue: Promise<void> = Promise.resolve();

async function dir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('recordings', { create: true });
}

async function openHandle(d: FileSystemDirectoryHandle, name: string): Promise<SyncHandle> {
  const fh = await d.getFileHandle(name, { create: true });
  if (typeof (fh as unknown as { createSyncAccessHandle?: unknown }).createSyncAccessHandle !== 'function') {
    throw new Error('This browser lacks FileSystemSyncAccessHandle support (please update your browser)');
  }
  return (await (fh as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle());
}

async function handle(msg: Req): Promise<unknown> {
  switch (msg.type) {
    case 'open': {
      const d = await dir();
      const video = await openHandle(d, `${msg.id}.${msg.ext}`);
      const meta = await openHandle(d, `${msg.id}.json`);
      sessions.set(msg.id, { video, meta, offset: video.getSize() });
      return { bytes: video.getSize() };
    }
    case 'write': {
      const s = sessions.get(msg.id);
      if (!s) throw new Error('Session not open');
      const n = s.video.write(msg.data, { at: s.offset });
      s.offset += n;
      s.video.flush();
      return { bytes: s.offset };
    }
    case 'meta': {
      const s = sessions.get(msg.id);
      if (!s) throw new Error('Session not open');
      const buf = encoder.encode(msg.json);
      s.meta.truncate(0);
      s.meta.write(buf, { at: 0 });
      s.meta.flush();
      return { bytes: s.offset };
    }
    case 'close': {
      const s = sessions.get(msg.id);
      if (!s) return { bytes: 0 };
      s.video.flush();
      s.video.close();
      s.meta.flush();
      s.meta.close();
      sessions.delete(msg.id);
      return { bytes: s.offset };
    }
  }
}

self.onmessage = (e: MessageEvent<Req>) => {
  const msg = e.data;
  queue = queue.then(async () => {
    try {
      const result = await handle(msg);
      (self as unknown as Worker).postMessage({ reqId: msg.reqId, ok: true, result });
    } catch (err) {
      (self as unknown as Worker).postMessage({
        reqId: msg.reqId,
        ok: false,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
    }
  });
};

export {};
