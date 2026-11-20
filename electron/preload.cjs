// Minimal, safe bridge for the main app window.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('recoderNative', {
  platform: 'electron',
  os: process.platform,
  reuseLastChoiceWithoutAudio: () => ipcRenderer.send('recoder:reuse-last-without-audio'),
  setSharePreference: (surface, audio) => ipcRenderer.send('recoder:share-preference', { surface, audio: !!audio }),
});
