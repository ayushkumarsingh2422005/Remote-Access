const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ssRemote', {
  onStatus: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('status', handler);
    return () => ipcRenderer.removeListener('status', handler);
  },
  onFrame: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('frame', handler);
    return () => ipcRenderer.removeListener('frame', handler);
  },
  onScreenInfo: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('screen-info', handler);
    return () => ipcRenderer.removeListener('screen-info', handler);
  },
  sendInput: (event) => ipcRenderer.send('input', event),
  getConfig: () => ipcRenderer.invoke('get-config'),
});
