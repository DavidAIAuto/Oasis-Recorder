// Minimal, safe bridge for the main app window.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('recoderNative', {
  platform: 'electron',
  os: process.platform,
  reuseLastChoiceWithoutAudio: () => ipcRenderer.send('recoder:reuse-last-without-audio'),
  setSharePreference: (surface, audio) => ipcRenderer.send('recoder:share-preference', { surface, audio: !!audio }),
  showBubble: (deviceId, size) => ipcRenderer.send('recoder:bubble-show', { deviceId: deviceId ?? null, size }),
  hideBubble: () => ipcRenderer.send('recoder:bubble-hide'),
  /** Fires when the user closes the bubble with its × button. Returns an unsubscribe. */
  onBubbleClosed: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('recoder:bubble-closed', handler);
    return () => ipcRenderer.removeListener('recoder:bubble-closed', handler);
  },
});
