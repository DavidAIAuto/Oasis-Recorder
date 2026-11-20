import { useEffect, useRef, useState } from 'react';
import { readLevel } from '../services/audioMixer';

/**
 * Live 0..1 level for an AnalyserNode. Uses requestAnimationFrame while the page is
 * visible and falls back to a timer when hidden (so a Picture-in-Picture mini bar keeps
 * animating while the main tab is in the background).
 */
export function useAudioMeter(analyser: AnalyserNode | null): number {
  const [level, setLevel] = useState(0);
  const peak = useRef(0);

  useEffect(() => {
    if (!analyser) {
      setLevel(0);
      return;
    }
    const buf = new Float32Array(analyser.fftSize);
    let raf = 0;
    let timer = 0;
    let last = 0;

    const sample = () => {
      const l = readLevel(analyser, buf);
      // fast attack, slow release
      peak.current = l > peak.current ? l : peak.current * 0.85 + l * 0.15;
      setLevel(Math.round(peak.current * 100) / 100);
    };

    const loop = (t: number) => {
      if (t - last > 33) {
        last = t;
        sample();
      }
      raf = requestAnimationFrame(loop);
    };

    const schedule = () => {
      cancelAnimationFrame(raf);
      window.clearInterval(timer);
      if (document.hidden) timer = window.setInterval(sample, 100);
      else raf = requestAnimationFrame(loop);
    };
    schedule();
    document.addEventListener('visibilitychange', schedule);
    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', schedule);
    };
  }, [analyser]);

  return level;
}
