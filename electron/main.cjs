const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage, clipboard, screen, session, protocol, net, dialog, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { WorkerClient } = require('./worker.cjs');
const { ResourceManager } = require('./resources.cjs');
const { defaultStyles, validateStyles, translationOptions } = require('./ai-options.cjs');
const { HyTranslator } = require('./hy.cjs');
const { basicDirection } = require('./query-policy.mjs');
const english = require('./locales/en.json');

protocol.registerSchemesAsPrivileged([{ scheme: 'bestdict', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const testing = process.env.BESTDICT_TEST === '1';
if (testing) app.setPath('userData', path.join(app.getPath('temp'), `bestdict-test-${process.pid}`));
let window, tray, trayMenu, dictionary, translator, resources, hy;
let quitting = false;
let settings;
let shortcutError = '';
let settingsPath;
const defaults = { aiStylesVersion: 0, aiStyles: defaultStyles, aiStyleId: 'basic', startup: true, shortcut: testing ? (process.env.BESTDICT_TEST_SHORTCUT || 'Control+Shift+D') : 'Control+Shift+D', theme: 'system', locale: 'zh-CN', trayHintSeen: false, bounds: null, dictionaryId: 'ecdict', autoDictionary: true, translationEngine: 'none' };
const root = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
const assets = app.isPackaged ? path.join(root, 'assets') : path.join(root, 'resources');

function loadSettings() {
  settingsPath = path.join(app.getPath('userData'), 'settings.json');
  try { settings = { ...defaults, ...JSON.parse(fs.readFileSync(settingsPath, 'utf8')) }; }
  catch {
    try { settings = { ...defaults, ...JSON.parse(fs.readFileSync(path.join(app.getPath('appData'), 'BestDic', 'settings.json'), 'utf8')) }; }
    catch { settings = { ...defaults }; }
  }
  if (typeof settings.autoDictionary !== 'boolean') settings.autoDictionary = true;
  try { settings.aiStyles = validateStyles(settings.aiStyles); } catch { settings.aiStyles = defaultStyles; }
  if (settings.aiStylesVersion < 2) {
    if (!settings.aiStyles.some(s => s.id === 'concise') && settings.aiStyles.length < 30) settings.aiStyles = [...settings.aiStyles, defaultStyles.find(s => s.id === 'concise')];
    settings.aiStylesVersion = 2;
  }
  if (!settings.aiStyles.some(s => s.id === settings.aiStyleId)) settings.aiStyleId = settings.aiStyles[0].id;
  if (testing) settings = { ...defaults };
  if (!['zh-CN', 'en'].includes(settings.locale)) settings.locale = 'zh-CN';
}

function nativeText(message) { return settings.locale === 'en' ? english[message] || message : message; }

function publicSettings() {
  return { ...settings, shortcutError, startupAvailable: app.isPackaged && ['win32', 'darwin'].includes(process.platform), traySettingsAvailable: process.platform === 'win32' };
}

function updateTray() {
  if (!tray || tray.isDestroyed()) return;
  tray.setToolTip(`BestDict · ${settings.shortcut.replace(/Control/g, 'Ctrl')}`);
  trayMenu = Menu.buildFromTemplate([
    { label: nativeText('打开 BestDict'), click: reveal },
    { label: nativeText('设置'), click: () => { reveal(); window.webContents.send('window:open-settings'); } },
    { type: 'separator' }, { label: nativeText('退出'), click: () => app.quit() },
  ]);
  tray.setContextMenu(trayMenu);
}

function hideToTray() {
  if (!window || !tray || tray.isDestroyed()) return;
  rememberBounds();
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
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  window.webContents.send('window:focus-input');
}

function toggle() {
  if (window.isVisible() && window.isFocused()) hideToTray();
  else reveal();
}

function registerShortcut(shortcut) {
  try { return globalShortcut.register(shortcut, toggle); } catch { return false; }
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
  if (!saved || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(saved[key]))) return { width: 1020, height: 720 };
  const area = screen.getDisplayMatching(saved).workArea;
  const width = Math.min(Math.max(780, saved.width), area.width);
  const height = Math.min(Math.max(580, saved.height), area.height);
  return { width, height, x: Math.max(area.x, Math.min(saved.x, area.x + area.width - width)), y: Math.max(area.y, Math.min(saved.y, area.y + area.height - height)) };
}

function rememberBounds() {
  if (!window || window.isMinimized() || window.isMaximized()) return;
  try { saveSettings({ ...settings, bounds: window.getBounds() }); } catch (error) { console.error(error); }
}

function setupIPC() {
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
  handle('translation:run', ({ text, direction, requestId }) => {
    validateText(text, 5000);
    if (!['auto', 'en-zh', 'zh-en', 'es-zh', 'zh-es', 'ja-zh', 'zh-ja', 'ko-zh', 'zh-ko', 'fr-zh', 'zh-fr'].includes(direction) || !Number.isSafeInteger(requestId)) throw new Error('无效的翻译请求。');
    if (settings.translationEngine === 'none') throw new Error('整句翻译尚未开启，请在设置中下载并启用翻译模型。');
    const route = basicDirection(text, direction);
    // Only the newest request can consume inference time; obsolete work is terminated.
    if (translator.pending.size) translator.stop();
    return translator.request('translate', { text, direction: route }).then(result => ({ ...result, engine: 'Argos Translate' }));
  });
  handle('translation:cancel', () => { if (translator.pending.size) translator.stop(); });
  handle('translation:ai', ({ text, direction, requestId, options }) => {
    validateText(text, 5000);
    if (!['auto', 'en-zh', 'zh-en', 'es-zh', 'zh-es', 'ja-zh', 'zh-ja', 'ko-zh', 'zh-ko', 'fr-zh', 'zh-fr'].includes(direction) || !Number.isSafeInteger(requestId)) throw new Error('无效的翻译请求。');
    if (!resources.hyStatus().ready) throw new Error('请先下载或导入 Hy-MT2 模型。');
    return hy.translate(text, direction, 'en', translationOptions(options));
  });
  handle('translation:ai-cancel', () => hy.cancel());
  handle('clipboard:copy', text => { clipboard.writeText(validateText(text, 20000)); return true; });
  handle('settings:get', publicSettings);
  handle('settings:set', changes => {
    if (!changes || typeof changes !== 'object') throw new Error('设置格式无效。');
    const next = { ...settings };
    if ('aiStyles' in changes) next.aiStyles = validateStyles(changes.aiStyles);
    if ('aiStyleId' in changes) next.aiStyleId = changes.aiStyleId;
    if (!next.aiStyles.some(s => s.id === next.aiStyleId)) next.aiStyleId = next.aiStyles[0].id;
    if ('autoDictionary' in changes) {
      if (typeof changes.autoDictionary !== 'boolean') throw new Error('自动匹配设置无效。');
      next.autoDictionary = changes.autoDictionary;
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
      if (changes.translationEngine === 'hy') throw new Error('Hy-MT2 请通过主界面的 AI 翻译按钮使用。');
      if (!['none', 'argos'].includes(changes.translationEngine)) throw new Error('翻译引擎无效。');
      if (changes.translationEngine === 'argos' && !resources.argosStatus().ready) throw new Error('请先下载 Argos 中英模型。');
      next.translationEngine = changes.translationEngine;
      if (resources.argosStatus().ready || next.translationEngine !== settings.translationEngine) next.argosConfigured = true;
    }
    if ('shortcut' in changes) {
      if (typeof changes.shortcut !== 'string' || !/^(?:(?:Control|Command|Alt|Shift|Super)\+){1,3}(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4]))$/.test(changes.shortcut)) throw new Error('请使用例如 Control+Shift+D 的快捷键格式。');
      if (changes.shortcut !== settings.shortcut || shortcutError) {
        if (!registerShortcut(changes.shortcut)) throw new Error('这个快捷键已被其他程序占用，请换一个组合。');
        if (changes.shortcut !== settings.shortcut) globalShortcut.unregister(settings.shortcut);
        next.shortcut = changes.shortcut;
        shortcutError = '';
      }
    }
    if (app.isPackaged && ['win32', 'darwin'].includes(process.platform) && !testing && next.startup !== settings.startup) {
      app.setLoginItemSettings({ openAtLogin: next.startup, path: process.execPath, name: 'BestDict', args: ['--hidden'] });
    }
    if (next.translationEngine !== settings.translationEngine) translator.stop();
    saveSettings(next);
    updateTray();
    return publicSettings();
  });
  handle('app:status', async () => {
    const current = { ...settings };
    const [dict] = await Promise.allSettled([dictionary.request('status', { database: resources.database(current.dictionaryId) })]);
    return {
      version: app.getVersion(), dictionaryCount: dict.status === 'fulfilled' ? dict.value.count : 0,
      modelReady: current.translationEngine === 'argos' && resources.argosStatus().ready,
      dictionaryName: resources.list().find(item => item.id === current.dictionaryId)?.name || '英语 ↔ 中文',
      engine: current.translationEngine,
      error: dict.status === 'rejected' ? dict.reason.message : '',
      shortcutError,
    };
  });
  handle('resources:list', () => ({ dictionaries: resources.list(), argos: resources.argosStatus(), hy: resources.hyStatus(), progress: resources.latestProgress }));
  async function installResource(id, source) {
    if (id === 'hy-mt2') hy.stop();
    if (id === 'argos') translator.stop();
    const result = await resources.install(id, source);
    if (id === 'argos' && result && resources.argosStatus().ready && !settings.argosConfigured) {
      saveSettings({ ...settings, translationEngine: 'argos', argosConfigured: true });
    }
    return result;
  }
  handle('resources:download', id => installResource(id));
  handle('resources:cancel', () => resources.cancel());
  handle('resources:copy-links', id => {
    const links = resources.downloadLinks(id);
    clipboard.writeText(links.join('\n'));
    return links.length;
  });
  handle('resources:import', async id => {
    if (!['argos', 'hy-mt2'].includes(id) && !resources.catalog.dictionaries.some(item => item.id === id)) throw new Error('未知资源。');
    const isArgos = id === 'argos';
    const selected = await dialog.showOpenDialog(window, { title: nativeText(isArgos ? '同时选择中英两个 Argos 模型包' : id === 'hy-mt2' ? '导入官方 Hy-MT2 Q4_K_M 模型' : '导入中文版 Wiktextract 数据'),
      properties: isArgos ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: isArgos ? [{ name: 'Argos model', extensions: ['argosmodel'] }] : id === 'hy-mt2' ? [{ name: nativeText('GGUF 模型'), extensions: ['gguf'] }] : [{ name: 'Wiktextract JSONL', extensions: ['gz', 'jsonl', 'json'] }] });
    if (selected.canceled) return null;
    if (isArgos && selected.filePaths.length !== 2) throw new Error('请同时选择中英两个方向的 .argosmodel 文件。');
    return installResource(id, isArgos ? selected.filePaths : selected.filePaths[0]);
  });
  handle('resources:source', id => {
    const url = id === 'argos' ? resources.argosSpec.homepage : id === 'hy-mt2' ? resources.hySpec.homepage : id === 'hy-license' ? resources.hySpec.licenseUrl : resources.list().find(item => item.id === id)?.homepage;
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
    if (process.platform === 'win32') app.setAppUserModelId('com.bestdict.desktop');
    const python = app.isPackaged ? path.join(root, 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3') :
      (process.env.BESTDICT_PYTHON || path.join(root, 'runtime', 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3'));
    dictionary = new WorkerClient(python, path.join(root, 'backend', 'worker.py'), assets, 'dictionary');
    resources = new ResourceManager({ assets, library: process.env.BESTDICT_LIBRARY && testing ? process.env.BESTDICT_LIBRARY : path.join(app.getPath('userData'), 'library'), python,
      script: path.join(root, 'backend', 'worker.py'), progress: data => window?.webContents.send('resources:progress', data) });
    translator = new WorkerClient(python, path.join(root, 'backend', 'worker.py'), resources.argosRoot(), 'translation');
    // Migrate the old global HY selection to the independent manual AI feature.
    if (settings.translationEngine === 'hy') settings.translationEngine = resources.argosStatus().ready ? 'argos' : 'none';
    if (!['none', 'argos'].includes(settings.translationEngine) ||
      (settings.translationEngine === 'argos' && !resources.argosStatus().ready)) settings.translationEngine = 'none';
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
      backgroundColor: '#fcfcfa', icon: path.join(assets, process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    window.setMenu(null);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.on('close', event => { if (!quitting) { event.preventDefault(); hideToTray(); } });
    let boundsTimer;
    for (const event of ['resize', 'move']) window.on(event, () => { clearTimeout(boundsTimer); boundsTimer = setTimeout(rememberBounds, 500); });
    setupIPC();
    const icon = process.platform === 'win32' ? path.join(assets, 'icon.ico') : nativeImage.createFromPath(path.join(assets, 'icon.png')).resize({ width: 32, height: 32 });
    tray = new Tray(icon);
    updateTray();
    tray.on('click', reveal);
    tray.on('double-click', reveal);
    tray.on('balloon-click', reveal);
    if (!registerShortcut(settings.shortcut)) shortcutError = `${settings.shortcut} 已被占用，请在设置中更换。`;
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
app.on('before-quit', () => { quitting = true; rememberBounds(); dictionary?.stop(); translator?.stop(); hy?.stop(); resources?.cancel(); });
app.on('will-quit', () => { globalShortcut.unregisterAll(); tray?.destroy(); });
// Native tray interaction is exercised by Playwright in an isolated test process.
if (testing) globalThis.__bestdictNative = { getTray: () => tray, getTrayMenu: () => trayMenu,
  getServices: () => ({ resources, translator, hy }),
  readSettings: () => JSON.parse(fs.readFileSync(settingsPath, 'utf8')) };
