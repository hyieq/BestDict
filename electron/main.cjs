const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage, nativeTheme, clipboard, screen, session, protocol, net, dialog, shell } = require('electron');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { WorkerClient } = require('./worker.cjs');
const { ResourceManager } = require('./resources.cjs');
const { ResourceQueue } = require('./resource-queue.cjs');
const { resolveSources } = require('./resources.cjs');
const { SpeechService } = require('./speech.cjs');
const { SpeechSessions } = require('./speech-stream.cjs');
const { defaultSpeech, validateSpeech } = require('./speech-options.cjs');
const { defaultStyles, validateStyles, translationOptions } = require('./ai-options.cjs');
const { HyTranslator } = require('./hy.cjs');
const { OCRService } = require('./ocr.cjs');
const { CaptureService } = require('./capture.cjs');
const { basicDirection } = require('./query-policy.mjs');
const { UpdateService } = require('./updates.cjs');
const { ShortcutManager } = require('./shortcuts.cjs');
const { defaultShortcuts, migrateShortcuts, normalizeShortcut, formatShortcut } = require('./shortcut-policy.mjs');
const english = require('./locales/en.json');

protocol.registerSchemesAsPrivileged([{ scheme: 'bestdict', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const testing = process.env.BESTDICT_TEST === '1';
if (testing) app.setPath('userData', path.join(app.getPath('temp'), `bestdict-test-${process.pid}`));
let window, tray, trayMenu, dictionary, translator, resources, hy, speech;
let speechSessions;
let downloads;
let quitting = false;
let settings;
let shortcutManager;
let shortcutError = '';
let miniShortcutError = '';
let captureShortcutError = '';
let capture, ocr, captureTranslator, captureHy;
let miniMode = false;
let miniPinned = false;
let switchingMode = false;
let lastMiniHeight = 0;
let settingsPath;
const supportsBackdrop = process.platform === 'win32' && Number(os.release().split('.')[2]) >= 22621;
let appearance = { material: 'fallback', dark: false, reducedTransparency: false };

function updateWindowAppearance() {
  if (!window || window.isDestroyed()) return;
  const dark = nativeTheme.shouldUseDarkColors;
  const reducedTransparency = nativeTheme.prefersReducedTransparency || nativeTheme.shouldUseHighContrastColors;
  let material = supportsBackdrop && !reducedTransparency ? 'acrylic' : reducedTransparency ? 'solid' : 'fallback';
  if (supportsBackdrop) {
    try { window.setBackgroundMaterial(material === 'acrylic' ? 'acrylic' : 'none'); }
    catch { material = reducedTransparency ? 'solid' : 'fallback'; }
  }
  window.setBackgroundColor(material === 'acrylic' ? '#00000000' : dark ? '#101b2c' : '#e9f1fb');
  appearance = { material, dark, reducedTransparency };
  window.webContents.send('window:appearance', appearance);
}
const defaultKeys = defaultShortcuts(process.platform);
const defaults = { aiStylesVersion: 0, aiStyles: defaultStyles, aiStyleId: 'basic', startup: true, shortcut: testing ? (process.env.BESTDICT_TEST_SHORTCUT || 'Control+Shift+D') : defaultKeys.shortcut, theme: 'system', locale: 'zh-CN', trayHintSeen: false, bounds: null, dictionaryId: 'ecdict', autoDictionary: true, translationEngine: 'none', translationNoticeDismissed: false };
const root = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
const assets = app.isPackaged ? path.join(root, 'assets') : path.join(root, 'resources');
const updates = new UpdateService({ version: app.getVersion(), openExternal: url => shell.openExternal(url) });

function loadSettings() {
  Object.assign(defaults, { captureShortcut: testing ? 'Control+Alt+Shift+F8' : defaultKeys.captureShortcut, miniShortcut: testing ? 'Control+Alt+Shift+F9' : defaultKeys.miniShortcut, miniHideOnBlur: true, miniRememberPosition: true, miniBounds: null });
  settingsPath = path.join(app.getPath('userData'), 'settings.json');
  try { settings = { ...defaults, ...JSON.parse(fs.readFileSync(settingsPath, 'utf8')) }; }
  catch {
    try { settings = { ...defaults, ...JSON.parse(fs.readFileSync(path.join(app.getPath('appData'), 'BestDic', 'settings.json'), 'utf8')) }; }
    catch { settings = { ...defaults }; }
  }
  settings = migrateShortcuts(settings, process.platform);
  if (typeof settings.autoDictionary !== 'boolean') settings.autoDictionary = true;
  if (typeof settings.translationNoticeDismissed !== 'boolean') settings.translationNoticeDismissed = false;
  try { settings.speech = validateSpeech(settings.speech); } catch { settings.speech = defaultSpeech; }
  try { settings.aiStyles = validateStyles(settings.aiStyles); } catch { settings.aiStyles = defaultStyles; }
  if (settings.aiStylesVersion < 2) {
    if (!settings.aiStyles.some(s => s.id === 'concise') && settings.aiStyles.length < 30) settings.aiStyles = [...settings.aiStyles, defaultStyles.find(s => s.id === 'concise')];
    settings.aiStylesVersion = 2;
  }
  if (!settings.aiStyles.some(s => s.id === settings.aiStyleId)) settings.aiStyleId = settings.aiStyles[0].id;
  if (testing) settings = { ...defaults, speech: defaultSpeech };
  if (!['zh-CN', 'en'].includes(settings.locale)) settings.locale = 'zh-CN';
  if (!['light', 'dark', 'system'].includes(settings.theme)) settings.theme = 'system';
}

function nativeText(message) { return settings.locale === 'en' ? english[message] || message : message; }

function updateSpeechStandby() {
  if (quitting || !speech || !window || window.isDestroyed()) return;
  // Background preparation never blocks opening the window. Playback reports errors if needed.
  const captureVisible = capture?.result && !capture.result.isDestroyed() && capture.result.isVisible() && !capture.result.isMinimized();
  void speech.setActive((window.isVisible() && !window.isMinimized()) || !!captureVisible, settings.speech).catch(() => {});
}

async function cancelSpeech() { await speech.cancel(); updateSpeechStandby(); }

function stopSpeechPlayers(except) {
  for (const target of [window, capture?.result]) {
    if (target && !target.isDestroyed() && target.webContents !== except) target.webContents.send('speech:stop');
  }
}

function publicSettings() {
  return { ...settings, platform: process.platform, shortcutError, miniShortcutError, captureShortcutError, captureAvailable: process.platform === 'win32', startupAvailable: app.isPackaged && ['win32', 'darwin'].includes(process.platform), traySettingsAvailable: process.platform === 'win32' };
}

function updateTray() {
  if (!tray || tray.isDestroyed()) return;
  tray.setToolTip(`BestDict · ${formatShortcut(settings.shortcut, process.platform)}`);
  trayMenu = Menu.buildFromTemplate([
    { label: nativeText('打开 BestDict'), click: reveal },
    { label: nativeText('迷你模式'), click: () => showMode(true) },
    { label: nativeText('截图翻译'), click: startCapture, enabled: process.platform === 'win32' },
    { label: nativeText('设置'), click: () => { reveal(); window.webContents.send('window:open-settings'); } },
    { type: 'separator' }, { label: nativeText('退出'), click: () => app.quit() },
  ]);
  tray.setContextMenu(trayMenu);
}

function hideToTray() {
  if (!window || !tray || tray.isDestroyed()) return;
  rememberBounds();
  speechSessions?.cancel(undefined, window.webContents);
  window.webContents.send('speech:stop');
  window.hide();
  if (process.platform === 'win32' && !settings.trayHintSeen) {
    saveSettings({ ...settings, trayHintSeen: true });
    if (!testing) tray.displayBalloon({ title: nativeText('BestDict 已最小化到系统托盘'),
      content: nativeText('点击任务栏右下角的 BestDict 图标可重新打开。若图标被折叠，请在 ^ 中查找。'), noSound: true });
  }
}

function saveSettings(next) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath + '.tmp', JSON.stringify(next, null, 2));
  fs.renameSync(settingsPath + '.tmp', settingsPath);
  settings = next;
}

function reveal() {
  if (!window) return;
  showMode(false);
}

function modeState() { return { mini: miniMode, pinned: miniPinned }; }

function setWindowBounds(bounds) {
  window.setBounds(bounds);
  // Compensate frameless-window rounding on fractional Windows display scales.
  const actual = window.getBounds();
  const dw = actual.width - bounds.width, dh = actual.height - bounds.height;
  if ((dw || dh) && Math.abs(dw) <= 4 && Math.abs(dh) <= 4) {
    window.setBounds({ ...bounds, width: bounds.width - dw, height: bounds.height - dh });
  }
}

function miniBounds(height = 132) {
  const saved = settings.miniRememberPosition && settings.miniBounds;
  const valid = saved && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(saved[key]));
  const area = (valid ? screen.getDisplayMatching(saved) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())).workArea;
  const width = Math.min(valid ? Math.max(280, Math.min(saved.width, 640)) : 420, area.width);
  height = Math.min(Math.max(132, Math.round(height)), 520, area.height);
  const x = valid ? saved.x : area.x + (area.width - width) / 2;
  const y = valid ? saved.y : area.y + Math.min(120, area.height / 6);
  return { width, height, x: Math.round(Math.max(area.x, Math.min(x, area.x + area.width - width))), y: Math.round(Math.max(area.y, Math.min(y, area.y + area.height - height))) };
}

function showMode(mini) {
  if (!window) return;
  switchingMode = true;
  if (miniMode !== mini) {
    rememberBounds();
    if (window.isMaximized()) window.unmaximize();
    miniMode = mini;
    lastMiniHeight = 0;
    window.setMinimumSize(mini ? 280 : 780, mini ? 100 : 580);
    window.setResizable(true);
    setWindowBounds(mini ? miniBounds() : windowBounds());
  } else if (mini && !window.isVisible()) {
    setWindowBounds(miniBounds(window.getBounds().height));
  }
  window.setAlwaysOnTop(mini && miniPinned);
  window.webContents.send('window:mode', modeState());
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  window.webContents.send('window:focus-input');
  switchingMode = false;
}

function toggle() {
  if (!miniMode && window.isVisible() && window.isFocused()) hideToTray();
  else reveal();
}

function syncShortcutErrors() {
  shortcutError = shortcutManager?.errors.shortcut || '';
  miniShortcutError = shortcutManager?.errors.miniShortcut || '';
  captureShortcutError = shortcutManager?.errors.captureShortcut || '';
}
function restoreShortcuts() {
  if (quitting || !shortcutManager) return;
  shortcutManager.resume(); syncShortcutErrors();
}

function toggleMini() {
  if (miniMode && window.isVisible() && window.isFocused()) hideToTray();
  else showMode(true);
}

function startCapture() {
  void capture?.start().catch(error => { reveal(); window.webContents.send('capture:error', error.message); });
}

function trusted(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('无效的应用请求。');
}

function handle(channel, callback) {
  ipcMain.handle(channel, async (event, ...params) => {
    trusted(event);
    return callback(...params);
  });
}

function validateText(text, max) {
  if (typeof text !== 'string' || text.length > max) throw new Error(`输入内容不能超过 ${max.toLocaleString()} 个字符。`);
  return text;
}

function windowBounds() {
  const saved = settings.bounds;
  if (!saved || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(saved[key]))) {
    if (process.platform !== 'darwin') return { width: 1020, height: 720 };
    // Cocoa can treat an oversized initial frame as zoomed. Keep a margin so
    // rememberBounds can save the normal frame before entering mini mode.
    const area = screen.getPrimaryDisplay().workArea;
    const width = Math.min(1020, Math.max(780, area.width - 48));
    const height = Math.min(720, Math.max(580, area.height - 48));
    return { width, height, x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2) };
  }
  const area = screen.getDisplayMatching(saved).workArea;
  const width = Math.min(Math.max(780, saved.width), area.width);
  const height = Math.min(Math.max(580, saved.height), area.height);
  return { width, height, x: Math.max(area.x, Math.min(saved.x, area.x + area.width - width)), y: Math.max(area.y, Math.min(saved.y, area.y + area.height - height)) };
}

function rememberBounds() {
  if (!window || window.isMinimized() || window.isMaximized()) return;
  if (miniMode && !settings.miniRememberPosition) return;
  try { saveSettings({ ...settings, [miniMode ? 'miniBounds' : 'bounds']: window.getBounds() }); } catch (error) { console.error(error); }
}

function activateFirstTranslation(id) {
  if (settings.translationEngine !== 'none' || settings.sentenceConfigured || settings.argosConfigured) return;
  const engine = id === 'argos' && resources.argosStatus().ready ? 'argos' : id === 'hy-mt2' && resources.hyStatus().ready ? 'hy' : null;
  if (engine) {
    saveSettings({ ...settings, translationEngine: engine, argosConfigured: true, sentenceConfigured: true });
    capture?.publish({ engines: capture.engines() });
  }
}

function setupIPC() {
  handle('shortcuts:recording', recording => {
    if (typeof recording !== 'boolean') throw new Error('快捷键录制状态无效。');
    if (recording) { if (!window.isFocused()) throw new Error('请先激活快捷键输入框。'); shortcutManager.suspend(); }
    else restoreShortcuts();
    syncShortcutErrors();
    return { recording: shortcutManager.suspended, errors: shortcutManager.errors };
  });
  handle('shortcuts:check', value => shortcutManager.check(value));
  handle('ocr:status', () => ocr.status());
  handle('ocr:install', () => { if (downloads.active) throw new Error('请先暂停下载或安装。'); return ocr.install(); });
  handle('ocr:cancel', () => ocr.cancelDownload());
  handle('ocr:uninstall', () => { capture.cancelWork(); return ocr.uninstall(); });
  handle('screenshot:start', () => capture.start());
  handle('window:mode', () => modeState());
  handle('window:set-mode', mini => { if (typeof mini !== 'boolean') throw new Error('Invalid window mode'); showMode(mini); return modeState(); });
  handle('window:pin', pinned => {
    if (typeof pinned !== 'boolean') throw new Error('Invalid pin state');
    miniPinned = pinned; window.setAlwaysOnTop(miniMode && pinned);
    window.webContents.send('window:mode', modeState()); return modeState();
  });
  handle('window:mini-height', height => {
    if (!miniMode || !Number.isFinite(height)) return;
    const current = window.getBounds();
    const area = screen.getDisplayMatching(current).workArea;
    const nextHeight = Math.min(Math.max(132, Math.ceil(height * window.webContents.getZoomFactor())), 520, area.height);
    if (nextHeight === lastMiniHeight) return;
    lastMiniHeight = nextHeight;
    setWindowBounds({ ...current, width: Math.min(current.width, area.width), height: nextHeight,
      y: Math.max(area.y, Math.min(current.y, area.y + area.height - nextHeight)) });
  });
  handle('window:appearance', () => appearance);
  handle('dictionary:lookup', async text => {
    validateText(text, 100);
    const preferred = settings.dictionaryId;
    if (settings.autoDictionary) {
      const dictionaries = resources.list().filter(item => item.installed).map(item => ({ id: item.id, database: resources.database(item.id) }));
      return dictionary.request('lookup_all', { text, dictionaries, preferred }, { timeout: 15_000 });
    }
    const result = await dictionary.request('lookup', { text, database: resources.database(preferred) }, { timeout: 15_000 });
    return { ...result, dictionaryId: preferred, entries: result.entries.map(entry => ({ ...entry, dictionaryId: preferred })) };
  });
  handle('translation:run', ({ text, direction, requestId, options }) => {
    validateText(text, 5000);
    if (!['auto', 'en-zh', 'zh-en', 'es-zh', 'zh-es', 'ja-zh', 'zh-ja', 'ko-zh', 'zh-ko', 'fr-zh', 'zh-fr'].includes(direction) || !Number.isSafeInteger(requestId)) throw new Error('无效的翻译请求。');
    if (settings.translationEngine === 'none') throw new Error('整句翻译尚未开启，请在设置中下载并启用翻译模型。');
    if (settings.translationEngine === 'hy') {
      const style = settings.aiStyles.find(item => item.id === settings.aiStyleId);
      return hy.translate(text, direction, 'en', translationOptions({ styleName: style?.name, stylePrompt: style?.prompt, ...options }));
    }
    const route = basicDirection(text, direction);
    // Only the newest request can consume inference time; obsolete work is terminated.
    if (translator.pending.size) translator.stop();
    return translator.request('translate', { text, direction: route }).then(result => ({ ...result, engine: 'Argos Translate' }));
  });
  handle('translation:cancel', () => { if (translator.pending.size) translator.stop(); hy.cancel(); });
  handle('clipboard:copy', text => { clipboard.writeText(validateText(text, 20000)); return true; });
  handle('settings:get', publicSettings);
  handle('settings:set', changes => {
    if (!changes || typeof changes !== 'object') throw new Error('设置格式无效。');
    const next = { ...settings };
    if ('speech' in changes) next.speech = validateSpeech(changes.speech);
    if ('aiStyles' in changes) next.aiStyles = validateStyles(changes.aiStyles);
    if ('aiStyleId' in changes) next.aiStyleId = changes.aiStyleId;
    if (!next.aiStyles.some(s => s.id === next.aiStyleId)) next.aiStyleId = next.aiStyles[0].id;
    if ('autoDictionary' in changes) {
      if (typeof changes.autoDictionary !== 'boolean') throw new Error('自动匹配设置无效。');
      next.autoDictionary = changes.autoDictionary;
    }
    if ('translationNoticeDismissed' in changes) {
      if (typeof changes.translationNoticeDismissed !== 'boolean') throw new Error('提示显示设置无效。');
      next.translationNoticeDismissed = changes.translationNoticeDismissed;
    }
    if ('locale' in changes) {
      if (!['zh-CN', 'en'].includes(changes.locale)) throw new Error('界面语言无效。');
      next.locale = changes.locale;
    }
    if ('theme' in changes) {
      if (!['light', 'dark', 'system'].includes(changes.theme)) throw new Error('主题无效。');
      next.theme = changes.theme;
    }
    if ('startup' in changes) {
      if (typeof changes.startup !== 'boolean') throw new Error('开机启动设置无效。');
      next.startup = changes.startup;
    }
    if ('dictionaryId' in changes) {
      resources.database(changes.dictionaryId);
      next.dictionaryId = changes.dictionaryId;
    }
    if ('translationEngine' in changes) {
      if (!['none', 'argos', 'hy'].includes(changes.translationEngine)) throw new Error('翻译引擎无效。');
      if (changes.translationEngine === 'argos' && !resources.argosStatus().ready) throw new Error('请先下载 Argos 中英模型。');
      if (changes.translationEngine === 'hy' && !resources.hyStatus().ready) throw new Error('请先下载混元 AI 翻译模型。');
      next.translationEngine = changes.translationEngine;
      if (resources.argosStatus().ready || resources.hyStatus().ready || next.translationEngine !== settings.translationEngine) { next.argosConfigured = true; next.sentenceConfigured = true; }
    }
    for (const key of ['miniHideOnBlur', 'miniRememberPosition']) {
      if (key in changes) {
        if (typeof changes[key] !== 'boolean') throw new Error('Invalid mini setting');
        next[key] = changes[key];
      }
    }
    const shortcutChange = ['shortcut', 'miniShortcut', 'captureShortcut'].some(key => key in changes);
    if (shortcutChange) {
      for (const key of ['shortcut', 'miniShortcut', ...(process.platform === 'win32' ? ['captureShortcut'] : [])]) next[key] = normalizeShortcut(changes[key] ?? settings[key], process.platform);
      shortcutManager.configure(next); syncShortcutErrors();
    }
    if (app.isPackaged && ['win32', 'darwin'].includes(process.platform) && !testing && next.startup !== settings.startup) {
      app.setLoginItemSettings({ openAtLogin: next.startup, path: process.execPath, name: 'BestDict', args: ['--hidden'] });
    }
    const changedEngine = next.translationEngine !== settings.translationEngine;
    if (changedEngine) { translator.stop(); hy.cancel(); capture?.cancelWork(); }
    try { saveSettings(next); } catch (error) { if (shortcutChange) { shortcutManager.configure(settings, { partial: true }); syncShortcutErrors(); } throw error; }
    if (changedEngine) capture?.publish({ engines: capture.engines() });
    if ('speech' in changes) { speechSessions.cancel(); stopSpeechPlayers(); updateSpeechStandby(); }
    if ('theme' in changes) {
      nativeTheme.themeSource = settings.theme;
      updateWindowAppearance();
    }
    updateTray();
    return publicSettings();
  });
  handle('app:status', async () => {
    const current = { ...settings };
    const [dict] = await Promise.allSettled([dictionary.request('status', { database: resources.database(current.dictionaryId) })]);
    return {
      version: app.getVersion(), dictionaryCount: dict.status === 'fulfilled' ? dict.value.count : 0,
      modelReady: current.translationEngine === 'hy' ? resources.hyStatus().ready : current.translationEngine === 'argos' && resources.argosStatus().ready,
      dictionaryName: resources.list().find(item => item.id === current.dictionaryId)?.name || '英语 ↔ 中文',
      engine: current.translationEngine,
      error: dict.status === 'rejected' ? dict.reason.message : '',
      shortcutError,
    };
  });
  handle('speech:catalog', () => speech.catalog());
  handle('updates:check', () => updates.check());
  handle('updates:open', target => updates.open(target));
  handle('speech:cache-status', () => speech.cacheStatus());
  handle('speech:clear-cache', () => speech.clearCache());
  handle('speech:synthesize', request => speechSessions.start(window.webContents, request?.requestId, options => speech.synthesize(request?.text, request?.language, settings.speech, options)));
  handle('speech:preview', request => {
    const samples = { zh: '你好，欢迎使用词典。这是当前音色和语速的试听。', en: 'Hello, welcome to BestDict. This is a preview of your selected voice and speed.' };
    if (!Object.hasOwn(samples, request?.language)) throw new Error('试听语言无效。');
    return speechSessions.start(window.webContents, request.requestId, options => speech.synthesize(samples[request.language], request.language, validateSpeech(request.settings), options));
  });
  handle('speech:cancel', requestId => speechSessions.cancel(requestId, window.webContents));
  handle('resources:list', () => ({ dictionaries: resources.list(), argos: resources.argosStatus(), hy: resources.hyStatus(), kokoro: resources.kokoroStatus(), progress: resources.latestProgress }));
  handle('downloads:list', () => {
    const dictionaries = resources.list().filter(item => !item.builtIn);
    const entries = [
      { id: 'multi-dictionaries', title: '多语言词库', ready: dictionaries.every(item => item.installed), bytes: resources.catalog.source.downloadBytesEstimate,
        count: dictionaries.filter(item => item.installed).length, license: resources.catalog.source.license, homepage: resources.catalog.source.homepage },
      { id: 'argos', title: '基础句子翻译', ...resources.argosStatus() },
      { id: 'hy-mt2', title: '混元 AI 翻译', ...resources.hyStatus() },
      { id: 'kokoro', title: '中英离线发音', ...resources.kokoroStatus() },
      { id: 'ocr', title: '截图识别模型', ...ocr.status(), license: ocr.spec.license, homepage: ocr.spec.homepage },
    ].map(entry => {
      const service = entry.id === 'ocr' ? ocr : resources;
      const files = entry.id === 'ocr' ? service.filesFor() : service.filesFor(entry.id);
      return { ...entry, sources: entry.id === 'ocr' ? ocr.sourcesFor() : resources.sourcesFor(entry.id),
        files: files.map(file => file.filename), partialBytes: entry.id === 'ocr' ? ocr.pendingBytes() : resources.pendingBytes(entry.id) };
    });
    return { entries, jobs: downloads.snapshot() };
  });
  handle('downloads:enqueue', ({ ids, options = {} }) => {
    if (!Array.isArray(ids) || !options || typeof options !== 'object') throw new Error('下载资源无效。');
    if ((resources.activeJob || ocr.controller) && !downloads.active) throw new Error('请等待当前安装完成。');
    for (const id of ids) {
      if (id === 'ocr') {
        if (!ocr.status().supported) throw new Error('截图翻译目前仅支持 Windows。');
        resolveSources(ocr.filesFor(), ocr.sourcesFor(), options[id]);
      } else resolveSources(resources.filesFor(id), resources.sourcesFor(id), options[id]);
    }
    return downloads.enqueue(ids, options);
  });
  handle('downloads:pause', id => downloads.pause(id));
  handle('downloads:clear-cache', async id => {
    if (downloads.active || resources.activeJob || ocr.controller) throw new Error('请先暂停下载或安装。');
    if (id === 'ocr') {
      for (const file of ocr.filesFor()) for (const suffix of ['.part', '.part.json']) await fs.promises.rm(file.target + suffix, { force: true });
    } else await resources.clearCache(id);
    delete downloads.jobs[id]; downloads.save();
    return true;
  });
  handle('downloads:remove', async id => {
    if (downloads.active || resources.activeJob || ocr.controller) throw new Error('请先暂停下载或安装。');
    if (id === 'ocr') { capture.cancelWork(); await ocr.uninstall(); }
    else {
      if (id === 'hy-mt2') hy.stop();
      if (id === 'argos') translator.stop();
      if ((id === 'argos' && settings.translationEngine === 'argos') || (id === 'hy-mt2' && settings.translationEngine === 'hy')) {
        capture?.cancelWork();
        saveSettings({ ...settings, translationEngine: 'none', argosConfigured: true, sentenceConfigured: true });
        capture?.publish({ engines: capture.engines() });
      }
      if (id === 'kokoro') { await speech.suspend(); speechSessions.current = null; stopSpeechPlayers();
        if (settings.speech.engine === 'kokoro') saveSettings({ ...settings, speech: { ...settings.speech, engine: 'auto' } }); }
      if (id === 'multi-dictionaries') {
        await dictionary.stop();
        if (settings.dictionaryId !== 'ecdict') saveSettings({ ...settings, dictionaryId: 'ecdict' });
      }
      try { await resources.uninstall(id); }
      finally { if (id === 'kokoro') { speech.suspended = false; updateSpeechStandby(); } }
    }
    delete downloads.jobs[id]; downloads.save();
    return true;
  });
  async function installResource(id, source) {
    if (id === 'hy-mt2') hy.stop();
    if (id === 'argos') translator.stop();
    if (id === 'kokoro') {
      if (speech.suspended) throw new Error('已有资源正在安装，请等待完成或取消。');
      await speech.suspend(); speechSessions.current = null; stopSpeechPlayers();
    }
    let result;
    try { result = await resources.install(id, source, { replace: id === 'multi-dictionaries' && !!source }); }
    finally { if (id === 'kokoro') { speech.suspended = false; updateSpeechStandby(); } }
    if (result) activateFirstTranslation(id);
    return result;
  }
  handle('resources:download', id => { if (downloads.active) throw new Error('请先暂停下载或安装。'); return installResource(id); });
  handle('resources:cancel', () => resources.cancel());
  handle('resources:copy-links', id => {
    const links = resources.downloadLinks(id);
    clipboard.writeText(links.join('\n'));
    return links.length;
  });
  handle('resources:import', async id => {
    if (downloads.active) throw new Error('请先暂停下载或安装。');
    if (!['argos', 'hy-mt2', 'kokoro', 'multi-dictionaries', 'ocr'].includes(id) && !resources.catalog.dictionaries.some(item => item.id === id)) throw new Error('未知资源。');
    const isArgos = id === 'argos';
    const selected = await dialog.showOpenDialog(window, { title: nativeText(isArgos ? '同时选择中英两个 Argos 模型包' : id === 'kokoro' ? '导入官方 Kokoro INT8 中英语音包' : id === 'hy-mt2' ? '导入官方 Hy-MT2 Q4_K_M 模型' : '导入中文版 Wiktextract 数据'),
      properties: isArgos || id === 'ocr' ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: id === 'ocr' ? [{ name: 'OCR ONNX', extensions: ['onnx'] }] : isArgos ? [{ name: 'Argos model', extensions: ['argosmodel'] }] : id === 'kokoro' ? [{ name: 'Kokoro INT8', extensions: ['bz2'] }] : id === 'hy-mt2' ? [{ name: nativeText('GGUF 模型'), extensions: ['gguf'] }] : [{ name: 'Wiktextract JSONL', extensions: ['gz', 'jsonl', 'json'] }] });
    if (selected.canceled) return null;
    if (isArgos && selected.filePaths.length !== 2) throw new Error('请同时选择中英两个方向的 .argosmodel 文件。');
    if (id === 'ocr') { capture.cancelWork(); return ocr.import(selected.filePaths); }
    return installResource(id, isArgos ? selected.filePaths : selected.filePaths[0]);
  });
  handle('resources:source', id => {
    if (id === 'github') return shell.openExternal('https://github.com/hyieq/BestDict');
    const url = id === 'ocr' ? ocr.spec.homepage : id === 'multi-dictionaries' ? resources.catalog.source.homepage : id === 'kokoro' ? resources.kokoroSpec.homepage : id === 'argos' ? resources.argosSpec.homepage : id === 'hy-mt2' ? resources.hySpec.homepage : id === 'hy-license' ? resources.hySpec.licenseUrl : resources.list().find(item => item.id === id)?.homepage;
    if (!url) throw new Error('无效的来源。');
    return shell.openExternal(url);
  });
  handle('app:tray-settings', () => {
    if (process.platform !== 'win32') throw new Error('仅 Windows 支持此设置。');
    return shell.openExternal('ms-settings:taskbar');
  });
  for (const [channel, callback] of [
    ['window:hide', hideToTray], ['window:minimize', hideToTray], ['app:quit', () => app.quit()],
  ]) ipcMain.on(channel, event => { trusted(event); callback(); });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', reveal);
  app.whenReady().then(async () => {
    loadSettings();
    nativeTheme.themeSource = ['light', 'dark', 'system'].includes(settings.theme) ? settings.theme : 'system';
    if (process.platform === 'win32') app.setAppUserModelId('com.bestdict.desktop');
    const python = app.isPackaged ? path.join(root, 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3') :
      (process.env.BESTDICT_PYTHON || path.join(root, 'runtime', 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3'));
    dictionary = new WorkerClient(python, path.join(root, 'backend', 'worker.py'), assets, 'dictionary');
    resources = new ResourceManager({ assets, library: process.env.BESTDICT_LIBRARY && testing ? process.env.BESTDICT_LIBRARY : path.join(app.getPath('userData'), 'library'), python,
      script: path.join(root, 'backend', 'worker.py'), progress: data => { downloads?.update(data); if (window && !window.isDestroyed() && !quitting) window.webContents.send('resources:progress', data); } });
    translator = new WorkerClient(python, path.join(root, 'backend', 'worker.py'), resources.argosRoot(), 'translation');
    speech = new SpeechService({ python, backend: path.join(root, 'backend'), resources, cacheDirectory: path.join(app.getPath('userData'), 'speech-cache') });
    speechSessions = new SpeechSessions({ cancel: cancelSpeech, notify: stopSpeechPlayers });
    if (!['none', 'argos', 'hy'].includes(settings.translationEngine) ||
      (settings.translationEngine === 'argos' && !resources.argosStatus().ready) ||
      (settings.translationEngine === 'hy' && !resources.hyStatus().ready)) settings.translationEngine = 'none';
    if (!resources.list().some(item => item.id === settings.dictionaryId && item.installed)) settings.dictionaryId = 'ecdict';
    hy = new HyTranslator({ executable: path.join(root, app.isPackaged ? 'llama' : 'runtime/llama', process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'),
      modelFile: () => resources.modelFile(), isReady: () => resources.hyStatus().ready });
    const uiRoot = path.join(app.getAppPath(), 'dist');
    protocol.handle('bestdict', request => {
      const url = new URL(request.url);
      if (url.host !== 'app') return new Response('Not found', { status: 404 });
      const target = path.resolve(uiRoot, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
      if (!target.startsWith(uiRoot + path.sep)) return new Response('Forbidden', { status: 403 });
      return net.fetch(pathToFileURL(target).toString());
    });
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    window = new BrowserWindow({
      ...windowBounds(), minWidth: 780, minHeight: 580, frame: false, show: false, title: 'BestDict',
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#101b2c' : '#e9f1fb', icon: path.join(assets, process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    window.setMenu(null);
    updateWindowAppearance();
    nativeTheme.on('updated', updateWindowAppearance);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.on('close', event => { if (!quitting) { event.preventDefault(); hideToTray(); } });
    for (const event of ['show', 'hide', 'minimize', 'restore', 'focus']) window.on(event, updateSpeechStandby);
    window.on('blur', () => { if (miniMode && !miniPinned && settings.miniHideOnBlur && !switchingMode && !capture?.capturing) hideToTray(); });
    let boundsTimer;
    for (const event of ['resize', 'move']) window.on(event, () => { clearTimeout(boundsTimer); boundsTimer = setTimeout(rememberBounds, 500); });
    ocr = new OCRService({ python, backend: path.join(root, 'backend'), assets, library: resources.library });
    captureTranslator = new WorkerClient(python, path.join(root, 'backend', 'worker.py'), resources.argosRoot(), 'translation');
    captureHy = new HyTranslator({ executable: hy.executable, modelFile: () => resources.modelFile(), isReady: () => resources.hyStatus().ready });
    capture = new CaptureService({ ocr, settings: () => settings,
      url: () => process.env.BESTDICT_DEV_URL && !app.isPackaged ? process.env.BESTDICT_DEV_URL : 'bestdict://app/index.html',
      engines: () => ({ hy: settings.translationEngine === 'hy' && resources.hyStatus().ready, argos: settings.translationEngine === 'argos' && resources.argosStatus().ready }),
      hideMain: () => { const visible = window.isVisible(); const mini = miniMode; window.hide(); return () => { if (visible) showMode(mini); }; },
      openMain: (text, openSettings) => { reveal(); window.webContents.send('capture:open-main', { text, settings: !!openSettings, tab: openSettings || undefined }); },
      speak: (text, language, requestId, sender) => speechSessions.start(sender, requestId, options => speech.synthesize(text, language, settings.speech, options)),
      stopSpeech: (requestId, sender) => sender ? speechSessions.cancel(requestId, sender) : Promise.resolve(),
      onActivity: updateSpeechStandby,
      cancelTranslation: () => { captureTranslator.stop(); captureHy.cancel(); },
      runTranslation: async (text, direction, engine) => {
        if (settings.translationEngine === 'hy' && (engine === 'hy' || engine === 'auto')) return captureHy.translate(text, direction, 'en');
        if (engine === 'hy' || settings.translationEngine !== 'argos' || !resources.argosStatus().ready) throw new Error('请先在设置中下载并启用翻译模型。');
        const result = await captureTranslator.request('translate', { text, direction: basicDirection(text, direction) });
        return { ...result, engine: 'Argos Translate' };
      },
    });
    downloads = new ResourceQueue({ library: resources.library,
      known: id => ['multi-dictionaries', 'argos', 'hy-mt2', 'kokoro', 'ocr'].includes(id),
      cancel: id => id === 'ocr' ? ocr.cancelDownload() : resources.cancel(),
      run: async (id, options, signal) => {
        if (id === 'ocr') return ocr.install(options, { signal, onProgress: event => downloads.update(event) });
        const source = await resources.download(id, options, signal);
        signal.throwIfAborted();
        if (id === 'hy-mt2') hy.stop();
        if (id === 'argos') translator.stop();
        if (id === 'kokoro') { await speech.suspend(); speechSessions.current = null; stopSpeechPlayers(); }
        try {
          signal.throwIfAborted();
          const result = await resources.install(id, source);
          if (result) activateFirstTranslation(id);
          return result;
        } finally { if (id === 'kokoro') { speech.suspended = false; updateSpeechStandby(); } }
      } });
    setupIPC();
    const icon = process.platform === 'win32' ? path.join(assets, 'icon.ico') : nativeImage.createFromPath(path.join(assets, 'icon.png')).resize({ width: 32, height: 32 });
    tray = new Tray(icon);
    updateTray();
    tray.on('click', reveal);
    tray.on('double-click', reveal);
    tray.on('balloon-click', reveal);
    shortcutManager = new ShortcutManager(globalShortcut, { shortcut: toggle, miniShortcut: toggleMini, ...(process.platform === 'win32' ? { captureShortcut: startCapture } : {}) }, process.platform);
    shortcutManager.configure(settings, { partial: true }); syncShortcutErrors();
    for (const event of ['blur', 'hide', 'closed']) window.on(event, restoreShortcuts);
    window.webContents.on('did-start-navigation', restoreShortcuts);
    window.webContents.on('render-process-gone', restoreShortcuts);

    if (app.isPackaged && !testing && ['win32', 'darwin'].includes(process.platform)) {
      if (process.platform === 'win32') app.setLoginItemSettings({ openAtLogin: false, name: 'BestDic' });
      app.setLoginItemSettings({ openAtLogin: settings.startup, path: process.execPath, name: 'BestDict', args: ['--hidden'] });
    }
    window.once('ready-to-show', () => { if (!process.argv.includes('--hidden')) reveal(); });
    if (process.env.BESTDICT_DEV_URL && !app.isPackaged) await window.loadURL(process.env.BESTDICT_DEV_URL);
    else await window.loadURL('bestdict://app/index.html');
  }).catch(error => { console.error(error); app.quit(); });
}

app.on('activate', reveal);
app.on('window-all-closed', () => {});
app.on('before-quit', () => { quitting = true; downloads?.stop(); capture?.stop(); captureTranslator?.stop(); captureHy?.stop(); rememberBounds(); dictionary?.stop(); translator?.stop(); hy?.stop(); speech?.stop(); resources?.cancel(); });
app.on('will-quit', () => { globalShortcut.unregisterAll(); tray?.destroy(); });
// Native tray interaction is exercised by Playwright in an isolated test process.
if (testing) globalThis.__bestdictNative = { getTray: () => tray, getTrayMenu: () => trayMenu,
  toggleMini, toggleMain: toggle,
  getServices: () => ({ shortcutManager, resources, translator, hy, speech, ocr, capture, captureTranslator, captureHy, updates, downloads }),
  readSettings: () => JSON.parse(fs.readFileSync(settingsPath, 'utf8')) };
