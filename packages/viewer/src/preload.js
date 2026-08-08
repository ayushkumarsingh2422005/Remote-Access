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
  onClipboard: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('clipboard', handler);
    return () => ipcRenderer.removeListener('clipboard', handler);
  },
  onInputState: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('input-state', handler);
    return () => ipcRenderer.removeListener('input-state', handler);
  },
  onSession: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('session', handler);
    return () => ipcRenderer.removeListener('session', handler);
  },
  getInputState: () => ipcRenderer.invoke('get-input-state'),
  getSession: () => ipcRenderer.invoke('get-session'),
  sendInput: (event) => ipcRenderer.send('input', event),
  sendClipboardToHost: (text) => ipcRenderer.send('clipboard-to-host', text),
  readClipboard: () => ipcRenderer.invoke('read-clipboard'),
  writeClipboard: (text) => ipcRenderer.invoke('write-clipboard', text),
  getConfig: () => ipcRenderer.invoke('get-config'),
});
