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
  speech: (text, language, requestId) => ipcRenderer.invoke('capture:speech', text, language, requestId),
  onSpeechChunk: callback => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('speech:chunk', listener);
    return () => ipcRenderer.removeListener('speech:chunk', listener);
  },
  stopSpeech: requestId => ipcRenderer.invoke('capture:stop-speech', requestId),
  onStopSpeech: callback => {
    const listener = () => callback();
    ipcRenderer.on('speech:stop', listener);
    return () => ipcRenderer.removeListener('speech:stop', listener);
  },
  onState: callback => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('capture:state', listener);
    return () => ipcRenderer.removeListener('capture:state', listener);
  },
});
