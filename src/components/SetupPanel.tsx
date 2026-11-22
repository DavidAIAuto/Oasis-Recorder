import { AppWindow, Circle, Mic, MicOff, Monitor, PanelTop, PictureInPicture2, RefreshCw, Timer, Video, VideoOff, Volume2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { estimateMBPerHour } from '../services/mediaCapture';
import { cx, formatBytes } from '../lib/format';
import type { BubbleCorner, BubbleSize, CameraMode, FpsPreset, QuotaInfo, RecordingSettings, ResolutionPreset, ShareSurface } from '../types/recording';
import { isElectron } from '../lib/platform';

const SURFACES: { value: ShareSurface; label: string; sub: string; icon: typeof Monitor }[] = [
  { value: 'monitor', label: 'Entire Screen', sub: 'Any display', icon: Monitor },
  { value: 'window', label: 'Window', sub: 'Zoom, Meet, IDE…', icon: AppWindow },
  { value: 'browser', label: 'Browser Tab', sub: 'Single tab + its audio', icon: PanelTop },
];
import { CameraVideo } from './CameraBubble';
import { VuMeter } from './VuMeter';

interface Props {
  settings: RecordingSettings;
  onChange: (patch: Partial<RecordingSettings>) => void;
  mics: MediaDeviceInfo[];
  onRefreshMics: () => void;
  micLevel: number;
  micError: string | null;
  micActive: boolean;
  quota: QuotaInfo | null;
  busy: boolean;
  onStart: () => void;
  systemAudioHint: string;
  camera: CameraSetup;
}

export interface CameraSetup {
  /** No camera bubble mode works in this browser. */
  supported: boolean;
  floatingAvailable: boolean;
  compositeAvailable: boolean;
  /** The mode that will actually be used (the saved one may be unavailable here). */
  mode: CameraMode;
  devices: MediaDeviceInfo[];
  stream: MediaStream | null;
  error: string | null;
  /** Inline preview (skipped when the floating bubble window itself is the preview). */
  showPreview: boolean;
  /** Web floating mode: the bubble lives in a PiP window that needs a click to open. */
  canOpenBubble: boolean;
  bubbleOpen: boolean;
  onOpenBubble: () => void;
}

const CORNERS: { value: BubbleCorner; label: string }[] = [
  { value: 'tl', label: '↖' },
  { value: 'tr', label: '↗' },
  { value: 'bl', label: '↙' },
  { value: 'br', label: '↘' },
];

function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-40',
        checked ? 'bg-red-500' : 'bg-zinc-700',
      )}
    >
      <span className={cx('inline-block size-5 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-5' : 'translate-x-0.5')} />
    </button>
  );
}

function Segmented<T extends string | number>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-xl bg-zinc-800/80 p-1">
      {options.map((o) => (
        <button
          key={String(o.value)}
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={cx(
            'rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors',
            o.value === value ? 'bg-zinc-100 text-zinc-900 shadow' : 'text-zinc-400 hover:text-zinc-100',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Row({ icon, title, hint, children }: { icon: ReactNode; title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="text-zinc-500">{icon}</span>
        <div className="min-w-0">
          <div className="text-sm font-medium text-zinc-200">{title}</div>
          {hint && <div className="text-xs text-zinc-500">{hint}</div>}
        </div>
      </div>
      {children}
    </div>
  );
}

export function SetupPanel(p: Props) {
  const { settings: s, onChange } = p;
  const mbh = estimateMBPerHour(s.resolution, s.fps, s.micEnabled || s.systemAudio);
  const hoursLeft = p.quota && p.quota.quota > 0 ? p.quota.available / (mbh * 1e6) : null;

  return (
    <div className="grid gap-6 lg:grid-cols-[1.1fr_1fr]">
      {/* Left: capture + quality */}
      <section className="space-y-5">
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
          <h3 className="mb-3 text-xs font-semibold tracking-wider text-zinc-500 uppercase">What do you want to share?</h3>
          <div role="radiogroup" aria-label="Share source" className={cx('grid gap-2', isElectron ? 'grid-cols-2' : 'grid-cols-3')}>
            {SURFACES.filter((o) => !(isElectron && o.value === 'browser')).map((o) => {
              const selected = s.shareSurface === o.value;
              const Icon = o.icon;
              return (
                <button
                  key={o.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => onChange({ shareSurface: o.value })}
                  className={cx(
                    'rounded-xl border p-3 text-center text-xs transition focus-visible:ring-2 focus-visible:ring-red-500/60 focus-visible:outline-none',
                    selected
                      ? 'border-red-500/70 bg-red-500/10 text-zinc-100 shadow-[0_0_0_1px] shadow-red-500/30'
                      : 'border-transparent bg-zinc-800/60 text-zinc-300 hover:border-zinc-600 hover:bg-zinc-800',
                  )}
                >
                  <Icon className={cx('mx-auto mb-1.5 size-5', selected ? 'text-red-400' : 'text-zinc-400')} />
                  {o.label}
                  <div className="text-[10px] text-zinc-500">{o.sub}</div>
                </button>
              );
            })}
          </div>
          <p className="mt-3 text-xs text-zinc-500">
            {isElectron
              ? 'After you click Start, pick the exact screen or window to record.'
              : `After you click Start, your browser's picker opens on the ${s.shareSurface === 'monitor' ? 'Entire Screen' : s.shareSurface === 'window' ? 'Window' : 'Tab'} list so you can pick the exact one. For privacy, only the browser can list your screens.`}
          </p>
        </div>

        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-sm font-medium text-zinc-300">Resolution</span>
            <Segmented<ResolutionPreset>
              label="Resolution"
              value={s.resolution}
              onChange={(resolution) => onChange({ resolution })}
              options={[
                { value: '720p', label: '720p' },
                { value: '1080p', label: '1080p' },
                { value: 'native', label: 'Native' },
              ]}
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-sm font-medium text-zinc-300">Frame rate</span>
            <Segmented<FpsPreset>
              label="Frame rate"
              value={s.fps}
              onChange={(fps) => onChange({ fps })}
              options={[
                { value: 30, label: '30 fps' },
                { value: 60, label: '60 fps' },
              ]}
            />
          </div>
          <div className="flex flex-wrap justify-between gap-2 rounded-xl bg-zinc-900/60 px-4 py-3 text-xs text-zinc-400">
            <span>≈ <b className="text-zinc-200 tabular-nums">{(mbh / 1000).toFixed(2)} GB</b> per hour</span>
            {p.quota && p.quota.quota > 0 && (
              <span>
                {formatBytes(p.quota.available)} free{hoursLeft !== null && <> · room for ≈ <b className="text-zinc-200">{hoursLeft >= 100 ? '100+' : hoursLeft.toFixed(1)} h</b></>}
              </span>
            )}
          </div>
        </div>
      </section>

      {/* Right: audio */}
      <section className="space-y-4 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
        <Row icon={s.micEnabled ? <Mic className="size-5" /> : <MicOff className="size-5" />} title="Microphone" hint={s.micEnabled ? (p.micActive ? 'Live — speak to test' : 'Waiting for access…') : 'Off'}>
          <Switch label="Enable microphone" checked={s.micEnabled} onChange={(micEnabled) => onChange({ micEnabled })} />
        </Row>

        {s.micEnabled && (
          <div className="space-y-4 border-l-2 border-zinc-800 pl-4">
            <div className="flex gap-2">
              <select
                aria-label="Microphone device"
                value={s.micDeviceId ?? ''}
                onChange={(e) => onChange({ micDeviceId: e.target.value || null })}
                className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 focus:border-red-500 focus:outline-none"
              >
                <option value="">System default</option>
                {p.mics
                  .filter((m) => m.deviceId && m.deviceId !== 'default')
                  .map((m, i) => (
                    <option key={m.deviceId} value={m.deviceId}>
                      {m.label || `Microphone ${i + 1}`}
                    </option>
                  ))}
              </select>
              <button onClick={p.onRefreshMics} className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 text-zinc-300 hover:bg-zinc-700" aria-label="Refresh microphones" title="Refresh microphones">
                <RefreshCw className="size-4" />
              </button>
            </div>

            <VuMeter level={p.micActive ? p.micLevel : 0} />
            {p.micError && <p className="text-xs leading-relaxed text-red-300">{p.micError}</p>}

            <label className="block">
              <div className="mb-1 flex justify-between text-xs text-zinc-400">
                <span>Mic gain</span>
                <span className="tabular-nums">{Math.round(s.micGain * 100)}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={150}
                step={1}
                value={Math.round(s.micGain * 100)}
                onChange={(e) => onChange({ micGain: Number(e.target.value) / 100 })}
                className="w-full accent-red-500"
                aria-label="Microphone gain"
              />
            </label>

            <div className="grid gap-3 text-sm text-zinc-300">
              {(
                [
                  ['noiseSuppression', 'Noise suppression'],
                  ['echoCancellation', 'Echo cancellation'],
                  ['autoGainControl', 'Auto gain control'],
                ] as const
              ).map(([k, label]) => (
                <div key={k} className="flex items-center justify-between">
                  <span>{label}</span>
                  <Switch label={label} checked={s[k]} onChange={(v) => onChange({ [k]: v })} />
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="h-px bg-zinc-800" />

        <CameraSection s={s} onChange={onChange} c={p.camera} onRefresh={p.onRefreshMics} />

        <div className="h-px bg-zinc-800" />

        <Row icon={<Volume2 className="size-5" />} title="System audio" hint={p.systemAudioHint}>
          <Switch label="Capture system audio" checked={s.systemAudio} onChange={(systemAudio) => onChange({ systemAudio })} />
        </Row>
        <Row icon={<Timer className="size-5" />} title="3-second countdown">
          <Switch label="Countdown before recording" checked={s.countdown} onChange={(countdown) => onChange({ countdown })} />
        </Row>
      </section>

      <div className="lg:col-span-2">
        <button
          onClick={p.onStart}
          disabled={p.busy}
          className="group flex w-full items-center justify-center gap-3 rounded-2xl bg-red-600 px-6 py-4 text-lg font-semibold text-white shadow-lg shadow-red-900/30 transition hover:bg-red-500 focus-visible:ring-4 focus-visible:ring-red-500/40 focus-visible:outline-none disabled:cursor-wait disabled:opacity-60"
        >
          <Circle className="size-5 fill-white transition group-hover:scale-110" />
          {p.busy ? 'Waiting for screen selection…' : 'Start Recording'}
        </button>
      </div>
    </div>
  );
}

function CameraSection({ s, onChange, c, onRefresh }: { s: RecordingSettings; onChange: Props['onChange']; c: CameraSetup; onRefresh: () => void }) {
  const hint = !c.supported
    ? 'Needs Chrome/Edge or the Mac app'
    : !s.cameraEnabled
      ? 'Off'
      : c.mode === 'floating'
        ? 'Bubble floats on your screen — record "Entire Screen" to capture it'
        : 'Bubble is drawn into the video, whatever you share';
  return (
    <>
      <Row icon={s.cameraEnabled && c.supported ? <Video className="size-5" /> : <VideoOff className="size-5" />} title="Camera bubble" hint={hint}>
        <Switch label="Enable camera bubble" checked={s.cameraEnabled && c.supported} disabled={!c.supported} onChange={(cameraEnabled) => onChange({ cameraEnabled })} />
      </Row>

      {s.cameraEnabled && c.supported && (
        <div className="space-y-4 border-l-2 border-zinc-800 pl-4">
          <div className="flex gap-2">
            <select
              aria-label="Camera device"
              value={s.cameraDeviceId ?? ''}
              onChange={(e) => onChange({ cameraDeviceId: e.target.value || null })}
              className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 focus:border-red-500 focus:outline-none"
            >
              <option value="">Default camera</option>
              {c.devices
                .filter((d) => d.deviceId && d.deviceId !== 'default')
                .map((d, i) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Camera ${i + 1}`}
                  </option>
                ))}
            </select>
            <button onClick={onRefresh} className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 text-zinc-300 hover:bg-zinc-700" aria-label="Refresh cameras" title="Refresh cameras">
              <RefreshCw className="size-4" />
            </button>
          </div>

          <div className="flex items-start gap-4">
            {c.showPreview && (
              <div className="size-24 shrink-0 overflow-hidden rounded-full bg-zinc-800 ring-2 ring-zinc-700">
                {c.stream && <CameraVideo stream={c.stream} />}
              </div>
            )}
            <div className="min-w-0 flex-1 space-y-3">
              {c.floatingAvailable && c.compositeAvailable && (
                <Segmented<CameraMode>
                  label="Camera mode"
                  value={c.mode}
                  onChange={(cameraMode) => onChange({ cameraMode })}
                  options={[
                    { value: 'floating', label: 'Floating' },
                    { value: 'composite', label: 'In video' },
                  ]}
                />
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Segmented<BubbleSize>
                  label="Bubble size"
                  value={s.bubbleSize}
                  onChange={(bubbleSize) => onChange({ bubbleSize })}
                  options={[
                    { value: 'S', label: 'S' },
                    { value: 'M', label: 'M' },
                    { value: 'L', label: 'L' },
                  ]}
                />
                {c.mode === 'composite' && <Segmented<BubbleCorner> label="Bubble corner" value={s.bubbleCorner} onChange={(bubbleCorner) => onChange({ bubbleCorner })} options={CORNERS} />}
              </div>
              {c.canOpenBubble && !c.bubbleOpen && (
                <button onClick={c.onOpenBubble} className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-700">
                  <PictureInPicture2 className="size-4" /> Show bubble
                </button>
              )}
            </div>
          </div>
          {c.error && <p className="text-xs leading-relaxed text-red-300">{c.error}</p>}
        </div>
      )}
    </>
  );
}
