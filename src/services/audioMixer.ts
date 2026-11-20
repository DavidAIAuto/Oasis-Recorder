/**
 * Web Audio mixer: mic + system audio → one MediaStreamAudioDestinationNode.
 *
 *   mic ─► micGain ─┬─► dest
 *                   └─► analyser (VU meter, post-gain so mute shows silence)
 *   system ─► systemGain ─► dest
 *
 * Muting only ramps micGain to 0 — tracks are never stopped, so MediaRecorder's
 * audio track keeps producing (silent) samples and A/V stays in sync.
 */
export class AudioMixer {
  readonly ctx: AudioContext;
  readonly dest: MediaStreamAudioDestinationNode;
  readonly analyser: AnalyserNode;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private micGain: GainNode;
  private systemSource: MediaStreamAudioSourceNode | null = null;
  private systemGain: GainNode;
  private gain = 1;
  private muted = false;

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.dest = this.ctx.createMediaStreamDestination();
    this.micGain = this.ctx.createGain();
    this.systemGain = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.3;
    this.micGain.connect(this.dest);
    this.micGain.connect(this.analyser);
    this.systemGain.connect(this.dest);
  }

  async resume() {
    if (this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch {
        /* needs a user gesture; will retry on next interaction */
      }
    }
  }

  setMic(stream: MediaStream | null) {
    this.micSource?.disconnect();
    this.micSource = null;
    if (stream && stream.getAudioTracks().length) {
      this.micSource = this.ctx.createMediaStreamSource(stream);
      this.micSource.connect(this.micGain);
    }
  }

  setSystem(stream: MediaStream | null) {
    this.systemSource?.disconnect();
    this.systemSource = null;
    if (stream && stream.getAudioTracks().length) {
      this.systemSource = this.ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
      this.systemSource.connect(this.systemGain);
    }
  }

  get hasMic() {
    return !!this.micSource;
  }
  get hasSystem() {
    return !!this.systemSource;
  }

  private applyMicGain() {
    const v = this.muted ? 0 : this.gain;
    const t = this.ctx.currentTime;
    this.micGain.gain.cancelScheduledValues(t);
    this.micGain.gain.setValueAtTime(this.micGain.gain.value, t);
    // ~15ms ramp avoids clicks
    this.micGain.gain.linearRampToValueAtTime(v, t + 0.015);
  }

  setMicGain(gain: number) {
    this.gain = Math.max(0, Math.min(1.5, gain));
    this.applyMicGain();
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.applyMicGain();
  }

  get isMuted() {
    return this.muted;
  }

  get audioTracks(): MediaStreamTrack[] {
    return this.dest.stream.getAudioTracks();
  }

  dispose() {
    try {
      this.micSource?.disconnect();
      this.systemSource?.disconnect();
      this.micGain.disconnect();
      this.systemGain.disconnect();
      this.analyser.disconnect();
      this.dest.stream.getTracks().forEach((t) => t.stop());
    } catch {
      /* ignore */
    }
    if (this.ctx.state !== 'closed') this.ctx.close().catch(() => {});
  }
}

/** RMS level (0..1, perceptually scaled) from an analyser. Reuses the provided buffer. */
export function readLevel(analyser: AnalyserNode, buf: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  const rms = Math.sqrt(sum / buf.length);
  if (rms <= 0) return 0;
  const db = 20 * Math.log10(rms); // -inf..0
  return Math.max(0, Math.min(1, (db + 60) / 60));
}
