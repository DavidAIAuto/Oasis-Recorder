import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioMixer } from '../services/audioMixer';
import { describeMediaError, getCameraStream, getMicStream, listDevices, stopStream } from '../services/mediaCapture';

export type PermissionStateX = 'granted' | 'denied' | 'prompt' | 'unknown';

/** Microphone + camera lists and mic permission state, kept fresh on hot-plug (devicechange). */
export function useMediaDevices() {
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [permission, setPermission] = useState<PermissionStateX>('unknown');

  const refresh = useCallback(async () => {
    try {
      setMics(await listDevices('audioinput'));
      setCameras(await listDevices('videoinput'));
    } catch {
      setMics([]);
      setCameras([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const md = navigator.mediaDevices;
    if (!md) return;
    const onChange = () => void refresh();
    md.addEventListener?.('devicechange', onChange);

    let status: PermissionStatus | null = null;
    const onPerm = () => status && setPermission(status.state as PermissionStateX);
    navigator.permissions
      ?.query({ name: 'microphone' as PermissionName })
      .then((s) => {
        status = s;
        setPermission(s.state as PermissionStateX);
        s.addEventListener('change', onPerm);
      })
      .catch(() => setPermission('unknown'));

    return () => {
      md.removeEventListener?.('devicechange', onChange);
      status?.removeEventListener('change', onPerm);
    };
  }, [refresh]);

  return { mics, cameras, permission, setPermission, refresh };
}

export interface MicPreviewOptions {
  enabled: boolean;
  deviceId: string | null;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  gain: number;
  /** When true the stream is locked (in use by the recorder) and won't be re-acquired. */
  locked: boolean;
  onAcquired?: () => void;
}

/**
 * Owns the live microphone stream used both for the pre-recording VU meter and
 * (handed over) for the recording itself.
 */
export function useMicPreview(o: MicPreviewOptions) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);
  const mixerRef = useRef<AudioMixer | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const onAcquiredRef = useRef(o.onAcquired);
  onAcquiredRef.current = o.onAcquired;
  const lockedRef = useRef(o.locked);
  lockedRef.current = o.locked;

  const release = useCallback(() => {
    mixerRef.current?.dispose();
    mixerRef.current = null;
    stopStream(streamRef.current);
    streamRef.current = null;
    setStream(null);
    setAnalyser(null);
  }, []);

  useEffect(() => {
    if (o.locked) return; // never swap the mic under an active recording
    if (!o.enabled) {
      release();
      setError(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const s = await getMicStream({
          deviceId: o.deviceId,
          echoCancellation: o.echoCancellation,
          noiseSuppression: o.noiseSuppression,
          autoGainControl: o.autoGainControl,
        });
        if (cancelled) {
          stopStream(s);
          return;
        }
        release();
        const mixer = new AudioMixer();
        mixer.setMic(s);
        mixer.setMicGain(o.gain);
        // Preview mixer output is only analysed, never played back (no feedback loop).
        void mixer.resume();
        mixerRef.current = mixer;
        streamRef.current = s;
        setStream(s);
        setAnalyser(mixer.analyser);
        setError(null);
        setEnded(false);
        s.getAudioTracks()[0]?.addEventListener('ended', () => {
          if (streamRef.current === s) setEnded(true);
        });
        onAcquiredRef.current?.();
      } catch (e) {
        if (cancelled) return;
        release();
        setError(describeMediaError(e, 'microphone'));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.enabled, o.deviceId, o.echoCancellation, o.noiseSuppression, o.autoGainControl, o.locked, release]);

  // Gain changes don't need a new stream.
  useEffect(() => {
    mixerRef.current?.setMicGain(o.gain);
  }, [o.gain]);

  // Resume AudioContext on any user gesture (autoplay policies).
  useEffect(() => {
    const kick = () => void mixerRef.current?.resume();
    window.addEventListener('pointerdown', kick);
    window.addEventListener('keydown', kick);
    return () => {
      window.removeEventListener('pointerdown', kick);
      window.removeEventListener('keydown', kick);
    };
  }, []);

  useEffect(() => () => release(), [release]);

  return { stream, analyser, error, ended, retry: () => setEnded(false) };
}

export interface CameraPreviewOptions {
  enabled: boolean;
  deviceId: string | null;
  /** When true the stream is in use by the recorder and won't be re-acquired. */
  locked: boolean;
  onAcquired?: () => void;
}

/**
 * Owns the live camera stream. The setup preview, the floating bubble and the
 * compositor only borrow it; none of them stop it.
 */
export function useCameraPreview(o: CameraPreviewOptions) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const onAcquiredRef = useRef(o.onAcquired);
  onAcquiredRef.current = o.onAcquired;

  const release = useCallback(() => {
    stopStream(streamRef.current);
    streamRef.current = null;
    setStream(null);
  }, []);

  useEffect(() => {
    if (o.locked) return; // never swap the camera under an active recording
    if (!o.enabled) {
      release();
      setError(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const s = await getCameraStream(o.deviceId);
        if (cancelled) {
          stopStream(s);
          return;
        }
        release();
        streamRef.current = s;
        setStream(s);
        setError(null);
        s.getVideoTracks()[0]?.addEventListener('ended', () => {
          if (streamRef.current === s) setError('The camera was disconnected.');
        });
        onAcquiredRef.current?.();
      } catch (e) {
        if (cancelled) return;
        release();
        setError(describeMediaError(e, 'camera'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [o.enabled, o.deviceId, o.locked, release]);

  useEffect(() => () => release(), [release]);

  return { stream, error };
}
