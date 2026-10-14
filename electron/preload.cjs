const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bestdict', {
  startCapture: () => ipcRenderer.invoke('screenshot:start'),
  getOCR: () => ipcRenderer.invoke('ocr:status'),
  installOCR: () => ipcRenderer.invoke('ocr:install'),
  cancelOCRDownload: () => ipcRenderer.invoke('ocr:cancel'),
  uninstallOCR: () => ipcRenderer.invoke('ocr:uninstall'),
  onCaptureOpen: callback => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('capture:open-main', listener);
    return () => ipcRenderer.removeListener('capture:open-main', listener);
  },
  onCaptureError: callback => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('capture:error', listener);
    return () => ipcRenderer.removeListener('capture:error', listener);
  },
  getWindowMode: () => ipcRenderer.invoke('window:mode'),
  setMiniMode: mini => ipcRenderer.invoke('window:set-mode', mini),
  pinMini: pinned => ipcRenderer.invoke('window:pin', pinned),
  resizeMini: height => ipcRenderer.invoke('window:mini-height', height),
  onWindowMode: callback => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('window:mode', listener);
    return () => ipcRenderer.removeListener('window:mode', listener);
  },
  getSpeechCatalog: () => ipcRenderer.invoke('speech:catalog'),
  getSpeechCache: () => ipcRenderer.invoke('speech:cache-status'),
  clearSpeechCache: () => ipcRenderer.invoke('speech:clear-cache'),
  synthesizeSpeech: (text, language) => ipcRenderer.invoke('speech:synthesize', { text, language }),
  previewSpeech: (language, settings) => ipcRenderer.invoke('speech:preview', { language, settings }),
  cancelSpeech: () => ipcRenderer.invoke('speech:cancel'),
  onStopSpeech: callback => {
    const listener = () => callback();
    ipcRenderer.on('speech:stop', listener);
    return () => ipcRenderer.removeListener('speech:stop', listener);
  },
  getAppearance: () => ipcRenderer.invoke('window:appearance'),
  onAppearance: callback => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('window:appearance', listener);
    return () => ipcRenderer.removeListener('window:appearance', listener);
  },
  lookup: text => ipcRenderer.invoke('dictionary:lookup', text),
  translate: (text, direction, requestId) => ipcRenderer.invoke('translation:run', { text, direction, requestId }),
  translateAI: (text, direction, requestId, options) => ipcRenderer.invoke('translation:ai', { text, direction, requestId, options }),
  cancelAITranslation: () => ipcRenderer.invoke('translation:ai-cancel'),
  cancelTranslation: () => ipcRenderer.invoke('translation:cancel'),
  status: () => ipcRenderer.invoke('app:status'),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  openUpdatePage: target => ipcRenderer.invoke('updates:open', target),
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
