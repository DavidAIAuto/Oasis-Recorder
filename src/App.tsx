import { Circle, HardDrive, Lock, RefreshCw, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Countdown } from './components/Countdown';
import { ErrorBanner } from './components/ErrorBanner';
import { MiniPiPControls, isPipSupported, usePipWindow } from './components/MiniPiPControls';
import { RecordingBar } from './components/RecordingBar';
import { RecordingsList } from './components/RecordingsList';
import { RecoveryBanner } from './components/RecoveryBanner';
import { SetupPanel } from './components/SetupPanel';
import { Toasts } from './components/Toasts';
import { useAudioMeter } from './hooks/useAudioMeter';
import { useMediaDevices, useMicPreview } from './hooks/useMediaDevices';
import { useElapsed, useRecorder } from './hooks/useRecorder';
import { formatBytes } from './lib/format';
import { type ExportOptions, cleanupTempExports, exportRecording } from './services/exporter';
import { ConversionCancelled } from './services/mp4Converter';
import { hasDisplayMedia, hasMediaRecorder } from './services/mediaCapture';
import {
  type InterruptedSession,
  deleteRecording,
  estimateQuota,
  finalizeInterrupted,
  findInterrupted,
  isOpfsSupported,
  listCompleted,
} from './services/opfsStorage';
import type { QuotaInfo, RecordingMeta, RecordingSettings, Toast, ToastKind } from './types/recording';

const SETTINGS_KEY = 'recoder.settings.v1';

const DEFAULT_SETTINGS: RecordingSettings = {
  shareSurface: 'monitor',
  resolution: '1080p',
  fps: 30,
  systemAudio: true,
  micEnabled: true,
  micDeviceId: null,
  micGain: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  countdown: true,
};

function loadSettings(): RecordingSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<RecordingSettings>) };
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_SETTINGS;
}

function systemAudioHint(): string {
  const ua = navigator.userAgent;
  if (/Firefox\//.test(ua)) return 'Not supported by Firefox — use the mic, or Chrome/Edge for system audio';
  if (/Safari\//.test(ua) && !/Chrom(e|ium)\//.test(ua)) return 'Not supported by Safari — use the mic, or Chrome/Edge for system audio';
  if (window.recoderNative) return 'Records the audio of your Mac (macOS 13+)';
  if (/Mac OS X/.test(ua)) return 'Tick "Share audio" in the picker (macOS: browser-tab audio only)';
  return 'Tick "Share audio" in the browser picker';
}

export default function App() {
  const [settings, setSettings] = useState<RecordingSettings>(loadSettings);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [library, setLibrary] = useState<RecordingMeta[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [interrupted, setInterrupted] = useState<InterruptedSession[]>([]);
  const [quota, setQuota] = useState<QuotaInfo | null>(null);
  const toastSeq = useRef(0);

  const supported = useMemo(
    () => ({ opfs: isOpfsSupported(), display: hasDisplayMedia(), recorder: hasMediaRecorder(), pip: isPipSupported() }),
    [],
  );

  /* ----------------------------- toasts ----------------------------- */
  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const pushToast = useCallback(
    (kind: ToastKind, message: string) => {
      const id = ++toastSeq.current;
      setToasts((t) => [...t.slice(-4), { id, kind, message }]);
      window.setTimeout(() => dismissToast(id), kind === 'error' ? 10_000 : 6_000);
    },
    [dismissToast],
  );

  /* ----------------------------- library ----------------------------- */
  const refreshLibrary = useCallback(async () => {
    if (!supported.opfs) {
      setLibraryLoading(false);
      return;
    }
    try {
      setLibrary(await listCompleted());
      setQuota(await estimateQuota());
    } catch (e) {
      pushToast('error', `Could not read local recordings: ${(e as Error).message}`);
    } finally {
      setLibraryLoading(false);
    }
  }, [pushToast, supported.opfs]);

  useEffect(() => {
    void refreshLibrary();
    if (supported.opfs) {
      void cleanupTempExports();
      findInterrupted()
        .then(setInterrupted)
        .catch(() => setInterrupted([]));
    }
  }, [refreshLibrary, supported.opfs]);

  const onFinished = useCallback(() => void refreshLibrary(), [refreshLibrary]);

  /* ----------------------------- recorder ----------------------------- */
  const rec = useRecorder({ onToast: pushToast, onFinished });
  const { phase } = rec.state;
  const active = phase === 'recording' || phase === 'paused' || phase === 'stopping';
  const elapsed = useElapsed(rec.state.meta);

  /* ----------------------------- microphone ----------------------------- */
  const devices = useMediaDevices();
  const mic = useMicPreview({
    enabled: settings.micEnabled && supported.display,
    deviceId: settings.micDeviceId,
    echoCancellation: settings.echoCancellation,
    noiseSuppression: settings.noiseSuppression,
    autoGainControl: settings.autoGainControl,
    gain: settings.micGain,
    locked: phase !== 'idle',
    onAcquired: devices.refresh, // labels become available after permission
  });

  // If the selected mic was unplugged while idle, fall back to the default device.
  useEffect(() => {
    if (phase !== 'idle' || !settings.micDeviceId || !devices.mics.some((m) => m.deviceId)) return;
    if (!devices.mics.some((m) => m.deviceId === settings.micDeviceId)) {
      setSettings((s) => ({ ...s, micDeviceId: null }));
      pushToast('warning', 'Selected microphone was disconnected — switched to the system default.');
    }
  }, [devices.mics, settings.micDeviceId, phase, pushToast]);

  const level = useAudioMeter(active ? rec.analyser : mic.analyser);

  const updateSettings = useCallback(
    (patch: Partial<RecordingSettings>) => {
      setSettings((s) => {
        const next = { ...s, ...patch };
        try {
          localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
        } catch {
          /* ignore */
        }
        return next;
      });
      if (patch.micGain !== undefined) rec.setMicGain(patch.micGain);
    },
    [rec],
  );

  /* ----------------------------- actions ----------------------------- */
  const start = useCallback(async () => {
    setError(null);
    if (settings.micEnabled && !mic.stream) {
      pushToast('warning', mic.error ? 'Microphone unavailable — recording without it.' : 'Microphone not ready — recording without it.');
    }
    try {
      await rec.start(settings, settings.micEnabled ? mic.stream : null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [mic.error, mic.stream, pushToast, rec, settings]);

  const save = useCallback(
    async (m: RecordingMeta, o: ExportOptions) => {
      try {
        const r = await exportRecording(m, o);
        if (r === 'saved') pushToast('success', 'MP4 saved to your computer.');
        else if (r === 'downloaded') pushToast('info', 'MP4 download started — check your Downloads folder.');
      } catch (e) {
        if (e instanceof ConversionCancelled || (e instanceof DOMException && e.name === 'AbortError')) {
          pushToast('info', 'Save cancelled.');
          return;
        }
        pushToast('error', `Export failed: ${(e as Error).message}`);
      }
    },
    [pushToast],
  );

  const remove = useCallback(
    async (m: RecordingMeta) => {
      try {
        await deleteRecording(m);
        pushToast('success', 'Recording deleted.');
      } catch (e) {
        pushToast('error', `Delete failed: ${(e as Error).message}`);
      }
      await refreshLibrary();
    },
    [pushToast, refreshLibrary],
  );

  const finalize = useCallback(
    async (s: InterruptedSession) => {
      try {
        await finalizeInterrupted(s);
        setInterrupted((list) => list.filter((x) => x.meta.id !== s.meta.id));
        pushToast('success', 'Interrupted recording recovered and added to your library.');
        await refreshLibrary();
      } catch (e) {
        pushToast('error', (e as Error).message);
      }
    },
    [pushToast, refreshLibrary],
  );

  const discard = useCallback(
    async (s: InterruptedSession) => {
      try {
        await deleteRecording(s.meta);
        setInterrupted((list) => list.filter((x) => x.meta.id !== s.meta.id));
        await refreshLibrary();
      } catch (e) {
        pushToast('error', `Discard failed: ${(e as Error).message}`);
      }
    },
    [pushToast, refreshLibrary],
  );

  /* ----------------------------- PiP ----------------------------- */
  const pip = usePipWindow();
  useEffect(() => {
    if (!active && pip.pipWindow) pip.close();
  }, [active, pip]);

  /* ----------------------------- guards ----------------------------- */
  useEffect(() => {
    if (!active) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [active]);

  useEffect(() => {
    const base = 'Recoder — Free Screen Recorder';
    if (phase === 'recording') document.title = `● Recording — ${base}`;
    else if (phase === 'paused') document.title = `❚❚ Paused — ${base}`;
    else document.title = base;
  }, [phase]);

  const controls = {
    state: rec.state,
    elapsedMs: elapsed,
    micLevel: level,
    onPause: rec.pause,
    onResume: rec.resume,
    onStop: () => void rec.stop(),
    onToggleMute: rec.toggleMute,
  };

  const unsupported = !supported.opfs || !supported.display || !supported.recorder;

  return (
    <div className="min-h-screen bg-[radial-gradient(ellipse_at_top,_rgba(239,68,68,0.08),_transparent_50%)]">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-4 py-5 sm:px-6">
        <div className="flex items-center gap-2.5">
          <div className="flex size-8 items-center justify-center rounded-lg bg-zinc-900 ring-1 ring-zinc-800">
            <Circle className="size-4 fill-red-500 text-red-500" />
          </div>
          <span className="text-lg font-semibold tracking-tight">Recoder</span>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-zinc-500">
          <Lock className="size-3.5" />
          100% local · no account · no watermark · unlimited length
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-8 px-4 pb-24 sm:px-6">
        {unsupported && (
          <ErrorBanner
            message={
              !supported.display
                ? 'Screen recording is not available in this browser. Please use a recent desktop version of Chrome, Edge, Firefox or Safari.'
                : !supported.recorder
                  ? 'This browser does not support MediaRecorder.'
                  : 'This browser does not support the Origin Private File System sync API, which is required to stream long recordings safely to disk. Please update your browser (Chrome/Edge 102+, Firefox 111+, Safari 15.2+).'
            }
            onClose={() => {}}
          />
        )}

        <RecoveryBanner sessions={interrupted} onFinalize={finalize} onDiscard={discard} />

        {error && <ErrorBanner message={error} onClose={() => setError(null)} />}

        <section className="rounded-3xl border border-zinc-800 bg-zinc-900/60 p-5 shadow-2xl shadow-black/40 backdrop-blur sm:p-7">
          {active ? (
            <RecordingBar {...controls} pipSupported={supported.pip} pipOpen={!!pip.pipWindow} onTogglePip={() => (pip.pipWindow ? pip.close() : void pip.open())} />
          ) : (
            <SetupPanel
              settings={settings}
              onChange={updateSettings}
              mics={devices.mics}
              onRefreshMics={devices.refresh}
              micLevel={level}
              micError={mic.error}
              micActive={!!mic.stream}
              quota={quota}
              busy={phase === 'starting' || phase === 'countdown'}
              onStart={start}
              systemAudioHint={systemAudioHint()}
            />
          )}
        </section>

        <section className="space-y-4">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">Your recordings</h2>
              <p className="flex items-center gap-1.5 text-xs text-zinc-500">
                <HardDrive className="size-3.5" />
                Stored privately in this browser until you delete them
                {quota && quota.quota > 0 && <> · {formatBytes(quota.usage)} used of {formatBytes(quota.quota)}</>}
              </p>
            </div>
            <button onClick={() => void refreshLibrary()} className="rounded-lg p-2 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200" aria-label="Refresh library">
              <RefreshCw className="size-4" />
            </button>
          </div>
          <RecordingsList items={library} loading={libraryLoading} onSave={save} onDelete={remove} />
        </section>
      </main>

      <footer className="mx-auto flex max-w-5xl items-center justify-center gap-2 px-4 pb-8 text-xs text-zinc-600">
        <ShieldCheck className="size-3.5" /> Free &amp; open. Nothing ever leaves your device.
      </footer>

      {phase === 'countdown' && <Countdown value={rec.state.countdown} onCancel={() => void rec.stop()} />}
      <MiniPiPControls pipWindow={pip.pipWindow} {...controls} />
      <Toasts toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
