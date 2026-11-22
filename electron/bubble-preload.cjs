// Bridge for the camera bubble window: it can only ask to be closed.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bubble', {
  close: () => ipcRenderer.send('recoder:bubble-close'),
});
