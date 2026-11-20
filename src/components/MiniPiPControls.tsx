import { Mic, MicOff, Pause, Play, Square } from 'lucide-react';
import { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { cx, formatDuration } from '../lib/format';
import type { RecordingControlsProps } from './RecordingBar';

export const isPipSupported = () => typeof window !== 'undefined' && 'documentPictureInPicture' in window && !!window.documentPictureInPicture;

function copyStyles(target: Document) {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const css = Array.from(sheet.cssRules)
        .map((r) => r.cssText)
        .join('\n');
      const style = target.createElement('style');
      style.textContent = css;
      target.head.appendChild(style);
    } catch {
      // Cross-origin sheet: link it instead.
      if (sheet.href) {
        const link = target.createElement('link');
        link.rel = 'stylesheet';
        link.href = sheet.href;
        target.head.appendChild(link);
      }
    }
  }
}

/** Document Picture-in-Picture window manager (Chrome/Edge 116+). */
export function usePipWindow() {
  const [pipWindow, setPipWindow] = useState<Window | null>(null);

  // Must be called synchronously from a user gesture.
  const open = useCallback(async () => {
    const dpip = window.documentPictureInPicture;
    if (!dpip) return;
    try {
      const w = await dpip.requestWindow({ width: 340, height: 120 });
      copyStyles(w.document);
      w.document.documentElement.className = 'dark';
      w.document.body.className = 'bg-zinc-950 text-zinc-100 antialiased m-0';
      w.document.title = 'Recoder';
      w.addEventListener('pagehide', () => setPipWindow(null));
      setPipWindow(w);
    } catch {
      setPipWindow(null);
    }
  }, []);

  const close = useCallback(() => {
    setPipWindow((w) => {
      w?.close();
      return null;
    });
  }, []);

  return { pipWindow, open, close };
}

function MiniBar(p: RecordingControlsProps) {
  const { state } = p;
  const paused = state.phase === 'paused';
  const hasMic = !!state.meta?.hasMic;
  const btn = 'flex size-10 items-center justify-center rounded-lg transition disabled:opacity-40';
  return (
    <div className="flex h-screen items-center gap-3 px-3">
      <span className={cx('size-2.5 shrink-0 rounded-full', paused ? 'bg-amber-400' : 'animate-pulse bg-red-500')} />
      <div className="relative min-w-0 flex-1">
        <div className={cx('font-mono text-2xl font-semibold tabular-nums', paused && 'text-zinc-400')}>{formatDuration(p.elapsedMs)}</div>
        {hasMic && (
          <div className="mt-1 h-1 overflow-hidden rounded bg-zinc-800">
            <div
              className={cx('h-full transition-[width] duration-75', state.micMuted ? 'bg-zinc-600' : 'bg-emerald-400')}
              style={{ width: `${state.micMuted ? 0 : Math.round(p.micLevel * 100)}%` }}
            />
          </div>
        )}
      </div>
      {hasMic && (
        <button
          onClick={p.onToggleMute}
          disabled={!state.micLive}
          title={state.micMuted ? 'Unmute' : 'Mute'}
          className={cx(btn, state.micMuted ? 'bg-red-500/20 text-red-300' : 'bg-zinc-800 hover:bg-zinc-700')}
        >
          {state.micMuted ? <MicOff className="size-5" /> : <Mic className="size-5" />}
        </button>
      )}
      <button onClick={paused ? p.onResume : p.onPause} title={paused ? 'Resume' : 'Pause'} className={cx(btn, 'bg-zinc-800 hover:bg-zinc-700')}>
        {paused ? <Play className="size-5" /> : <Pause className="size-5" />}
      </button>
      <button onClick={p.onStop} title="Stop & Save" className={cx(btn, 'bg-red-600 text-white hover:bg-red-500')}>
        <Square className="size-4 fill-white" />
      </button>
    </div>
  );
}

export function MiniPiPControls({ pipWindow, ...controls }: RecordingControlsProps & { pipWindow: Window | null }) {
  if (!pipWindow) return null;
  return createPortal(<MiniBar {...controls} />, pipWindow.document.body);
}
