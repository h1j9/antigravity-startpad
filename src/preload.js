const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, callback) => {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('startpad', {
  boot: () => ipcRenderer.invoke('boot'),
  probe: () => ipcRenderer.invoke('probe'),
  launch: () => ipcRenderer.invoke('launch'),
  restore: () => ipcRenderer.invoke('restore'),
  chooseTarget: () => ipcRenderer.invoke('choose-target'),
  resetTarget: () => ipcRenderer.invoke('reset-target'),
  setConfig: config => ipcRenderer.invoke('set-config', config),
  quitInstances: pids => ipcRenderer.invoke('quit-instances', pids),
  openExternal: url => ipcRenderer.invoke('open-external', url),
  openBackups: () => ipcRenderer.invoke('open-backups'),
  onLog: callback => on('log', callback),
  onSessionChanged: callback => on('session-changed', callback),
  onProbeRefresh: callback => on('probe-refresh', callback),
});
