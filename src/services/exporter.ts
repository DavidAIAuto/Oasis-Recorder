import type { RecordingMeta } from '../types/recording';
import { convertToMp4 } from './mp4Converter';
import { getRecordingFile } from './opfsStorage';
import { withDuration } from './webmDuration';

export function canSaveAs(): boolean {
  return typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';
}

function pad(n: number) {
  return String(n).padStart(2, '0');
}

/** Exports are always MP4. */
export function exportFileName(meta: RecordingMeta): string {
  const d = new Date(meta.startTime);
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  return `recording-${stamp}.mp4`;
}

/** Whether saving this recording requires a WebM → MP4 conversion first. */
export const needsConversion = (meta: RecordingMeta) => meta.ext !== 'mp4';

/** Disk-backed, seekable Blob for preview (duration patched for WebM). */
export async function getPlayableBlob(meta: RecordingMeta): Promise<Blob> {
  const file = await getRecordingFile(meta);
  return withDuration(file, meta.durationMs, meta.mimeType || file.type || `video/${meta.ext}`);
}

export interface ExportOptions {
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/** Write the recording as MP4 into an open writable (streams; converts WebM on the fly). */
async function writeMp4(meta: RecordingMeta, writable: FileSystemWritableFileStream, o: ExportOptions) {
  const file = await getRecordingFile(meta);
  if (!needsConversion(meta)) {
    await file.stream().pipeTo(writable, { signal: o.signal });
    return;
  }
  await convertToMp4(file, writable, { durationMs: meta.durationMs, onProgress: o.onProgress, signal: o.signal });
}

function triggerDownload(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser time to start reading the disk-backed blob before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function exportsDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('exports', { create: true });
}

/** Remove leftovers of previous fallback exports (called on app start). */
export async function cleanupTempExports(): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('exports', { recursive: true });
  } catch {
    /* nothing to clean */
  }
}

/**
 * Export a recording as MP4 without loading it into RAM.
 * Returns 'saved' | 'downloaded' | 'cancelled'.
 */
export async function exportRecording(meta: RecordingMeta, o: ExportOptions = {}): Promise<'saved' | 'downloaded' | 'cancelled'> {
  const name = exportFileName(meta);

  if (canSaveAs()) {
    let handle: FileSystemFileHandle;
    try {
      // Ask for the location first, while we still have the click's user activation.
      handle = await window.showSaveFilePicker!({
        suggestedName: name,
        types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }],
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled';
      throw e;
    }
    const writable = await handle.createWritable();
    try {
      await writeMp4(meta, writable, o);
    } catch (e) {
      await writable.abort().catch(() => {});
      throw e;
    }
    return 'saved';
  }

  // Fallback (Firefox/Safari): MP4 recordings download directly; WebM is converted into a
  // temporary OPFS file first, then downloaded from disk.
  if (!needsConversion(meta)) {
    triggerDownload(await getRecordingFile(meta), name);
    return 'downloaded';
  }
  const dir = await exportsDir();
  const tmp = await dir.getFileHandle(`${meta.id}.mp4`, { create: true });
  if (typeof (tmp as FileSystemFileHandle & { createWritable?: unknown }).createWritable !== 'function') {
    throw new Error('MP4 conversion needs a newer browser. Use Chrome, Edge or the Recoder desktop app.');
  }
  const writable = await tmp.createWritable();
  try {
    await writeMp4(meta, writable, o);
  } catch (e) {
    await writable.abort().catch(() => {});
    throw e;
  }
  triggerDownload(await tmp.getFile(), name);
  return 'downloaded';
}
