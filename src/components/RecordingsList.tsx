import { Download, Film, Loader2, Play, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { canSaveAs, exportFileName, getPlayableBlob } from '../services/exporter';
import { formatBytes, formatDuration } from '../lib/format';
import type { RecordingMeta } from '../types/recording';

interface Props {
  items: RecordingMeta[];
  loading: boolean;
  onSave: (m: RecordingMeta) => Promise<void>;
  onDelete: (m: RecordingMeta) => Promise<void>;
}

function PreviewModal({ meta, onClose, onSave }: { meta: RecordingMeta; onClose: () => void; onSave: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    let u: string | null = null;
    let cancelled = false;
    getPlayableBlob(meta)
      .then((blob) => {
        if (cancelled) return;
        u = URL.createObjectURL(blob); // disk-backed: no RAM copy of the video
        setUrl(u);
      })
      .catch((e) => setError((e as Error).message));
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeRef.current();
    window.addEventListener('keydown', onKey);
    return () => {
      cancelled = true;
      window.removeEventListener('keydown', onKey);
      if (u) URL.revokeObjectURL(u);
    };
  }, [meta]);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm" onClick={onClose} role="dialog" aria-modal="true" aria-label="Recording preview">
      <div className="w-full max-w-5xl overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
          <div className="min-w-0 truncate text-sm font-medium">{exportFileName(meta)}</div>
          <div className="flex items-center gap-2">
            <button onClick={onSave} className="flex items-center gap-1.5 rounded-lg bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-900 hover:bg-white">
              <Download className="size-4" /> {canSaveAs() ? 'Save As…' : 'Download'}
            </button>
            <button onClick={onClose} className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" aria-label="Close preview">
              <X className="size-5" />
            </button>
          </div>
        </div>
        <div className="flex aspect-video items-center justify-center bg-black">
          {error ? (
            <p className="text-sm text-red-300">Could not open recording: {error}</p>
          ) : url ? (
            <video src={url} controls autoPlay className="h-full w-full" />
          ) : (
            <Loader2 className="size-8 animate-spin text-zinc-500" />
          )}
        </div>
      </div>
    </div>
  );
}

export function RecordingsList({ items, loading, onSave, onDelete }: Props) {
  const [preview, setPreview] = useState<RecordingMeta | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const run = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return <div className="flex justify-center py-10 text-zinc-500"><Loader2 className="size-6 animate-spin" /></div>;
  }

  if (!items.length) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-zinc-800 py-12 text-center text-zinc-500">
        <Film className="size-8" />
        <p className="text-sm">No recordings yet. They'll appear here, stored privately in your browser.</p>
      </div>
    );
  }

  return (
    <>
      <ul className="divide-y divide-zinc-800 overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/40">
        {items.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center gap-4 px-4 py-3 hover:bg-zinc-900/80">
            <button
              onClick={() => setPreview(m)}
              className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-zinc-800 text-zinc-300 hover:bg-red-600 hover:text-white"
              aria-label="Preview recording"
            >
              <Play className="size-5" />
            </button>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-zinc-100">
                {new Date(m.startTime).toLocaleString()}
                {m.recovered && <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300 uppercase">Recovered</span>}
              </div>
              <div className="text-xs text-zinc-500 tabular-nums">
                {formatDuration(m.durationMs)} · {formatBytes(m.bytesWritten)} · {m.ext.toUpperCase()}
                {m.hasMic && ' · Mic'}
                {m.hasSystemAudio && ' · System audio'}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                disabled={busy === m.id}
                onClick={() => run(m.id, () => onSave(m))}
                className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
              >
                {busy === m.id ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
                {canSaveAs() ? 'Save to Computer' : 'Download'}
              </button>
              {confirmDelete === m.id ? (
                <button
                  onClick={() => run(m.id, () => onDelete(m)).finally(() => setConfirmDelete(null))}
                  onBlur={() => setConfirmDelete(null)}
                  autoFocus
                  className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-500"
                >
                  Confirm delete
                </button>
              ) : (
                <button
                  onClick={() => setConfirmDelete(m.id)}
                  className="rounded-lg p-2 text-zinc-500 hover:bg-zinc-800 hover:text-red-400"
                  aria-label="Delete recording"
                >
                  <Trash2 className="size-4" />
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {preview && <PreviewModal meta={preview} onClose={() => setPreview(null)} onSave={() => void onSave(preview)} />}
    </>
  );
}
