import type { RecordingMeta } from '../types/recording';
import { getRecordingFile } from './opfsStorage';
import { withDuration } from './webmDuration';

export function canSaveAs(): boolean {
  return typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';
}

function pad(n: number) {
  return String(n).padStart(2, '0');
}

export function exportFileName(meta: RecordingMeta): string {
  const d = new Date(meta.startTime);
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  return `recording-${stamp}.${meta.ext}`;
}

/** Disk-backed, seekable Blob for preview/export (duration patched for WebM). */
export async function getPlayableBlob(meta: RecordingMeta): Promise<Blob> {
  const file = await getRecordingFile(meta);
  return withDuration(file, meta.durationMs, meta.mimeType || file.type || `video/${meta.ext}`);
}

/**
 * Export a recording without loading it into RAM.
 * Returns 'saved' | 'downloaded' | 'cancelled'.
 */
export async function exportRecording(meta: RecordingMeta): Promise<'saved' | 'downloaded' | 'cancelled'> {
  const name = exportFileName(meta);
  const mime = meta.ext === 'mp4' ? 'video/mp4' : 'video/webm';

  if (canSaveAs()) {
    let handle: FileSystemFileHandle;
    try {
      handle = await window.showSaveFilePicker!({
        suggestedName: name,
        types: [{ description: 'Video', accept: { [mime]: [`.${meta.ext}`] } }],
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled';
      throw e;
    }
    // Get the blob *after* the picker so the user-activation isn't consumed by async work first.
    const blob = await getPlayableBlob(meta);
    const writable = await handle.createWritable();
    await blob.stream().pipeTo(writable);
    return 'saved';
  }

  const blob = await getPlayableBlob(meta);
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
  return 'downloaded';
}
