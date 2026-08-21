const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // actions
  login: () => ipcRenderer.invoke('login'),
  logout: () => ipcRenderer.invoke('logout'),
  launch: () => ipcRenderer.invoke('launch'),
  getSettings: () => ipcRenderer.invoke('getSettings'),
  setRam: (v) => ipcRenderer.invoke('setRam', v),
  setShader: (v) => ipcRenderer.invoke('setShader', v),
  setAxiom: (v) => ipcRenderer.invoke('setAxiom', v),
  downloadUpdate: () => ipcRenderer.invoke('downloadUpdate'),
  copyIp: () => ipcRenderer.invoke('copyIp'),
  sendLogs: () => ipcRenderer.invoke('sendLogs'),
  // événements
  onSession: (cb) => ipcRenderer.on('session', (_e, d) => cb(d)),
  onUpdateButton: (cb) => ipcRenderer.on('updateButton', (_e, d) => cb(d)),
  onStatus: (cb) => ipcRenderer.on('status', (_e, d) => cb(d)),
  onProgress: (cb) => ipcRenderer.on('progress', (_e, d) => cb(d)),
  onClosed: (cb) => ipcRenderer.on('closed', (_e, d) => cb(d)),
  onUpdate: (cb) => ipcRenderer.on('update', (_e, d) => cb(d)),
  onUpdateInfo: (cb) => ipcRenderer.on('updateInfo', (_e, d) => cb(d)),
});
