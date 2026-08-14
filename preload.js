const { contextBridge, ipcRenderer } = require('electron');

// Pont sécurisé entre l'interface (renderer) et le processus principal
contextBridge.exposeInMainWorld('api', {
  login: () => ipcRenderer.invoke('login'),
  launch: (opts) => ipcRenderer.invoke('launch', opts),
  onStatus: (cb) => ipcRenderer.on('status', (_e, d) => cb(d)),
  onLog: (cb) => ipcRenderer.on('log', (_e, d) => cb(d)),
  onProgress: (cb) => ipcRenderer.on('progress', (_e, d) => cb(d)),
  onClosed: (cb) => ipcRenderer.on('closed', (_e, d) => cb(d)),
  onUpdate: (cb) => ipcRenderer.on('update', (_e, d) => cb(d)),
});
