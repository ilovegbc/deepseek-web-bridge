'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  start: () => ipcRenderer.invoke('start'),
  stop: () => ipcRenderer.invoke('stop'),
  state: () => ipcRenderer.invoke('state'),
  logs: () => ipcRenderer.invoke('logs'),
  getSettings: () => ipcRenderer.invoke('getSettings'),
  setSettings: (s) => ipcRenderer.invoke('setSettings', s),
  paths: () => ipcRenderer.invoke('paths'),
  appInfo: () => ipcRenderer.invoke('appInfo'),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onLog: (cb) => ipcRenderer.on('log', (_e, l) => cb(l))
});
