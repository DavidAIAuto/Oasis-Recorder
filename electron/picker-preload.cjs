const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('picker', {
  init: () => ipcRenderer.invoke('picker:init'),
  choose: (id, audio) => ipcRenderer.send('picker:choose', id ? { id, audio: !!audio } : null),
  openPrivacySettings: () => ipcRenderer.send('picker:open-privacy-settings'),
});
