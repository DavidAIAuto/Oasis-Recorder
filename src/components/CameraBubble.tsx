import { Mic, MicOff, Pause, Play, Square } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { cx, formatDuration } from '../lib/format';
import type { BubbleSize } from '../types/recording';
import type { RecordingControlsProps } from './RecordingBar';

/** Bubble diameter in CSS px (Electron window and Document PiP window). */
export const BUBBLE_PX: Record<BubbleSize, number> = { S: 160, M: 220, L: 300 };

/** Live, mirrored camera <video>. The stream is borrowed and never stopped here. */
export function CameraVideo({ stream, className }: { stream: MediaStream | null; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.srcObject = stream;
    if (stream) void v.play().catch(() => {});
  }, [stream]);
  return <video ref={ref} autoPlay muted playsInline className={cx('size-full -scale-x-100 object-cover', className)} />;
}

/**
 * Content of the Document Picture-in-Picture window in floating camera mode: a round
 * camera bubble, with the recording controls revealed on hover while recording.
 */
export function CameraBubble({ stream, active, controls }: { stream: MediaStream | null; active: boolean; controls: RecordingControlsProps }) {
  const { state } = controls;
  const paused = state.phase === 'paused';
  const hasMic = !!state.meta?.hasMic;
  const btn = 'flex size-8 items-center justify-center rounded-full transition disabled:opacity-40';
  return (
    <div className="group relative flex h-screen items-center justify-center p-2">
      <div className="relative aspect-square h-full max-w-full overflow-hidden rounded-full bg-zinc-900 ring-[3px] ring-white/85">
        {stream ? (
          <CameraVideo stream={stream} />
        ) : (
          <div className="flex size-full items-center justify-center p-6 text-center text-xs text-zinc-400">Camera unavailable</div>
        )}
      </div>
      {active && (
        <div className="absolute inset-x-0 bottom-2 flex justify-center opacity-0 transition-opacity group-hover:opacity-100">
          <div className="flex items-center gap-1.5 rounded-full bg-zinc-950/85 px-2 py-1 shadow-lg ring-1 ring-zinc-700">
            <span className={cx('size-2 rounded-full', paused ? 'bg-amber-400' : 'animate-pulse bg-red-500')} />
            <span className="px-1 font-mono text-xs tabular-nums">{formatDuration(controls.elapsedMs)}</span>
            {hasMic && (
              <button onClick={controls.onToggleMute} disabled={!state.micLive} title={state.micMuted ? 'Unmute' : 'Mute'} className={cx(btn, state.micMuted ? 'bg-red-500/25 text-red-300' : 'hover:bg-zinc-800')}>
                {state.micMuted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
              </button>
            )}
            <button onClick={paused ? controls.onResume : controls.onPause} title={paused ? 'Resume' : 'Pause'} className={cx(btn, 'hover:bg-zinc-800')}>
              {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
            </button>
            <button onClick={controls.onStop} title="Stop & Save" className={cx(btn, 'bg-red-600 text-white hover:bg-red-500')}>
              <Square className="size-3 fill-white" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
