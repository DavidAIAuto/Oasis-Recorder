import type { BubbleSize, ShareSurface } from '../types/recording';

/** Bridge exposed by the Electron preload script (undefined in the browser / extension). */
export interface NativeBridge {
  platform: 'electron';
  os: string;
  setSharePreference(surface: ShareSurface, audio: boolean): void;
  reuseLastChoiceWithoutAudio(): void;
  /** Show (or update) the floating camera bubble window. */
  showBubble(deviceId: string | null, size: BubbleSize): void;
  hideBubble(): void;
  /** The user closed the bubble with its × button. Returns an unsubscribe function. */
  onBubbleClosed(cb: () => void): () => void;
}

declare global {
  interface Window {
    recoderNative?: NativeBridge;
  }
}

export const native: NativeBridge | undefined = typeof window !== 'undefined' ? window.recoderNative : undefined;

export const isElectron = !!native;

export const isExtension =
  typeof location !== 'undefined' && (location.protocol === 'chrome-extension:' || location.protocol === 'moz-extension:');
