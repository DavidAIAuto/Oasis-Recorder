import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { activeElapsedMs, recorderEngine } from '../services/recorderEngine';
import type { RecordingMeta, RecordingSettings, ToastKind } from '../types/recording';

export function useRecorder(handlers: {
  onToast: (kind: ToastKind, message: string) => void;
  onFinished: (meta: RecordingMeta) => void;
}) {
  const state = useSyncExternalStore(recorderEngine.subscribe, recorderEngine.getState);
  const { onToast, onFinished } = handlers;

  useEffect(
    () =>
      recorderEngine.onEvent((e) => {
        if (e.type === 'toast') onToast(e.kind, e.message);
        else if (e.type === 'finished') onFinished(e.meta);
      }),
    [onToast, onFinished],
  );

  const start = useCallback((s: RecordingSettings, mic: MediaStream | null, camera: MediaStream | null) => recorderEngine.start(s, mic, camera), []);
  const stop = useCallback(() => recorderEngine.stop(), []);
  const pause = useCallback(() => recorderEngine.pause(), []);
  const resume = useCallback(() => recorderEngine.resume(), []);
  const toggleMute = useCallback(() => recorderEngine.toggleMute(), []);
  const setMicGain = useCallback((g: number) => recorderEngine.setMicGain(g), []);
  const setCameraHidden = useCallback((h: boolean) => recorderEngine.setCameraHidden(h), []);

  return {
    state,
    analyser: state.phase === 'recording' || state.phase === 'paused' ? recorderEngine.analyser : null,
    start,
    stop,
    pause,
    resume,
    toggleMute,
    setMicGain,
    setCameraHidden,
  };
}

/** Re-renders periodically and returns active elapsed ms (frozen while paused). */
export function useElapsed(meta: RecordingMeta | null): number {
  const [now, setNow] = useState(() => Date.now());
  const running = !!meta && meta.status === 'recording';
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, [running]);
  return activeElapsedMs(meta, running ? now : Date.now());
}
