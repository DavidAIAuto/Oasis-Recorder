import { HardDrive, Mic, MicOff, Pause, PictureInPicture2, Play, Square } from 'lucide-react';
import { cx, formatBytes, formatDuration } from '../lib/format';
import type { EngineState } from '../types/recording';
import { VuMeter } from './VuMeter';

export interface RecordingControlsProps {
  state: EngineState;
  elapsedMs: number;
  micLevel: number;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onToggleMute: () => void;
}

interface Props extends RecordingControlsProps {
  pipSupported: boolean;
  pipOpen: boolean;
  onTogglePip: () => void;
}

export function RecordingBar(p: Props) {
  const { state } = p;
  const paused = state.phase === 'paused';
  const stopping = state.phase === 'stopping';
  const hasMic = !!state.meta?.hasMic;

  return (
    <div className="space-y-6">
      <div className="flex flex-col items-center gap-2 py-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className={cx('size-2.5 rounded-full', paused ? 'bg-amber-400' : stopping ? 'bg-zinc-500' : 'animate-pulse bg-red-500')} />
          <span className={paused ? 'text-amber-300' : stopping ? 'text-zinc-400' : 'text-red-400'}>
            {stopping ? 'Finalizing…' : paused ? 'Paused' : 'Recording'}
          </span>
        </div>
        <div className={cx('font-mono text-6xl font-semibold tracking-tight tabular-nums sm:text-7xl', paused && 'text-zinc-400')}>
          {formatDuration(p.elapsedMs)}
        </div>
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <HardDrive className="size-4" />
          <span className="tabular-nums">{formatBytes(state.bytesWritten)}</span> saved to disk
          {state.quota && state.quota.quota > 0 && (
            <span className={cx('ml-2 tabular-nums', state.lowSpace && 'font-semibold text-amber-300')}>
              · {formatBytes(Math.max(0, state.quota.available - state.bytesWritten))} free
            </span>
          )}
        </div>
      </div>

      {state.lowSpace && (
        <div role="alert" className="rounded-xl border border-amber-500/40 bg-amber-950/40 px-4 py-2 text-center text-sm text-amber-200">
          Storage is running low — the recording will auto-stop and save before space runs out.
        </div>
      )}

      {hasMic && (
        <div className="mx-auto flex max-w-xl items-center gap-3">
          {state.micMuted || !state.micLive ? <MicOff className="size-4 text-red-400" /> : <Mic className="size-4 text-zinc-400" />}
          <VuMeter level={p.micLevel} muted={state.micMuted || !state.micLive} className="flex-1" />
          {!state.micLive && <span className="text-xs text-red-300">Disconnected</span>}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-center gap-3">
        {hasMic && (
          <button
            onClick={p.onToggleMute}
            disabled={stopping || !state.micLive}
            aria-pressed={state.micMuted}
            className={cx(
              'flex items-center gap-2 rounded-xl px-5 py-3 font-medium transition disabled:opacity-40',
              state.micMuted ? 'bg-red-500/15 text-red-300 ring-1 ring-red-500/50 hover:bg-red-500/25' : 'bg-zinc-800 text-zinc-100 hover:bg-zinc-700',
            )}
          >
            {state.micMuted ? <MicOff className="size-5" /> : <Mic className="size-5" />}
            {state.micMuted ? 'Unmute' : 'Mute'}
          </button>
        )}
        <button
          onClick={paused ? p.onResume : p.onPause}
          disabled={stopping}
          className="flex items-center gap-2 rounded-xl bg-zinc-800 px-5 py-3 font-medium text-zinc-100 transition hover:bg-zinc-700 disabled:opacity-40"
        >
          {paused ? <Play className="size-5" /> : <Pause className="size-5" />}
          {paused ? 'Resume' : 'Pause'}
        </button>
        <button
          onClick={p.onStop}
          disabled={stopping}
          className="flex items-center gap-2 rounded-xl bg-red-600 px-6 py-3 font-semibold text-white shadow-lg shadow-red-900/30 transition hover:bg-red-500 disabled:opacity-40"
        >
          <Square className="size-4 fill-white" />
          Stop &amp; Save
        </button>
        {p.pipSupported && (
          <button
            onClick={p.onTogglePip}
            disabled={stopping}
            className="flex items-center gap-2 rounded-xl border border-zinc-700 px-4 py-3 text-sm text-zinc-300 transition hover:bg-zinc-800 disabled:opacity-40"
          >
            <PictureInPicture2 className="size-4" />
            {p.pipOpen ? 'Close Mini Bar' : 'Float Mini Bar'}
          </button>
        )}
      </div>
    </div>
  );
}
