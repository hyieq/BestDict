const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bestdict', {
  lookup: text => ipcRenderer.invoke('dictionary:lookup', text),
  translate: (text, direction, requestId) => ipcRenderer.invoke('translation:run', { text, direction, requestId }),
  translateAI: (text, direction, requestId) => ipcRenderer.invoke('translation:ai', { text, direction, requestId }),
  cancelAITranslation: () => ipcRenderer.invoke('translation:ai-cancel'),
  cancelTranslation: () => ipcRenderer.invoke('translation:cancel'),
  status: () => ipcRenderer.invoke('app:status'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: settings => ipcRenderer.invoke('settings:set', settings),
  getResources: () => ipcRenderer.invoke('resources:list'),
  downloadResource: id => ipcRenderer.invoke('resources:download', id),
  importResource: id => ipcRenderer.invoke('resources:import', id),
  copyDownloadLinks: id => ipcRenderer.invoke('resources:copy-links', id),
  cancelDownload: () => ipcRenderer.invoke('resources:cancel'),
  openSource: id => ipcRenderer.invoke('resources:source', id),
  openTraySettings: () => ipcRenderer.invoke('app:tray-settings'),
  onOpenSettings: callback => {
    const listener = () => callback();
    ipcRenderer.on('window:open-settings', listener);
    return () => ipcRenderer.removeListener('window:open-settings', listener);
  },
  onResourceProgress: callback => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('resources:progress', listener);
    return () => ipcRenderer.removeListener('resources:progress', listener);
  },
  hide: () => ipcRenderer.send('window:hide'),
  minimize: () => ipcRenderer.send('window:minimize'),
  quit: () => ipcRenderer.send('app:quit'),
  copy: text => ipcRenderer.invoke('clipboard:copy', text),
  onFocus: callback => {
    const listener = () => callback();
    ipcRenderer.on('window:focus-input', listener);
    return () => ipcRenderer.removeListener('window:focus-input', listener);
  },
});
