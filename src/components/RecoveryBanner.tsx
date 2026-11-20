import { LifeBuoy, Loader2, Save, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { InterruptedSession } from '../services/opfsStorage';
import { formatBytes, formatDuration } from '../lib/format';

interface Props {
  sessions: InterruptedSession[];
  onFinalize: (s: InterruptedSession) => Promise<void>;
  onDiscard: (s: InterruptedSession) => Promise<void>;
}

export function RecoveryBanner({ sessions, onFinalize, onDiscard }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  if (!sessions.length) return null;

  const run = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-2xl border border-amber-500/40 bg-amber-950/30 p-4">
      <div className="mb-3 flex items-center gap-2 text-amber-200">
        <LifeBuoy className="size-5" />
        <h2 className="font-semibold">
          {sessions.length === 1 ? 'An interrupted recording was found' : `${sessions.length} interrupted recordings were found`}
        </h2>
      </div>
      <p className="mb-4 text-sm text-amber-100/70">
        The tab or browser closed while recording. Everything up to the last saved second is safe on disk.
      </p>
      <ul className="space-y-2">
        {sessions.map((s) => (
          <li key={s.meta.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-zinc-900/60 px-4 py-3">
            <div className="text-sm">
              <div className="font-medium text-zinc-100">{new Date(s.meta.startTime).toLocaleString()}</div>
              <div className="text-xs text-zinc-400 tabular-nums">
                {s.meta.durationMs > 0 && <>≥ {formatDuration(s.meta.durationMs)} · </>}{formatBytes(s.fileSize)} · {s.meta.ext.toUpperCase()}
              </div>
            </div>
            <div className="flex gap-2">
              <button
                disabled={!!busy || s.fileSize === 0}
                onClick={() => run(s.meta.id, () => onFinalize(s))}
                className="flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-sm font-semibold text-zinc-950 hover:bg-amber-400 disabled:opacity-50"
              >
                {busy === s.meta.id ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                Finalize &amp; Save
              </button>
              <button
                disabled={!!busy}
                onClick={() => run(s.meta.id, () => onDiscard(s))}
                className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
              >
                <Trash2 className="size-4" />
                Discard
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
