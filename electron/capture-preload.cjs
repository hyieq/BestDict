const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('capture', {
  init: () => ipcRenderer.invoke('capture:init'),
  select: rect => ipcRenderer.invoke('capture:select', rect),
  cancel: () => ipcRenderer.invoke('capture:cancel'),
  close: () => ipcRenderer.invoke('capture:close'),
  retry: () => ipcRenderer.invoke('capture:retry'),
  translate: (text, direction, engine) => ipcRenderer.invoke('capture:translate', text, direction, engine),
  cancelWork: () => ipcRenderer.invoke('capture:cancel-work'),
  copy: text => ipcRenderer.invoke('capture:copy', text),
  pin: value => ipcRenderer.invoke('capture:pin', value),
  open: (text, settings) => ipcRenderer.invoke('capture:open', text, settings),
  speech: (text, language) => ipcRenderer.invoke('capture:speech', text, language),
  stopSpeech: () => ipcRenderer.invoke('capture:stop-speech'),
  onState: callback => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('capture:state', listener);
    return () => ipcRenderer.removeListener('capture:state', listener);
  },
});
