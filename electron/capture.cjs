const { BrowserWindow, desktopCapturer, screen, ipcMain, nativeImage, nativeTheme, clipboard } = require('electron');
const path = require('node:path');

function cropRect(rect, size) {
  if (!rect || !['x', 'y', 'width', 'height'].every(k => Number.isFinite(rect[k])) ||
      rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0 ||
      rect.x + rect.width > 1.001 || rect.y + rect.height > 1.001) throw new Error('截图选区无效。');
  const x = Math.min(size.width - 1, Math.round(rect.x * size.width));
  const y = Math.min(size.height - 1, Math.round(rect.y * size.height));
  const width = Math.min(size.width - x, Math.round(rect.width * size.width));
  const height = Math.min(size.height - y, Math.round(rect.height * size.height));
  if (width < 8 || height < 8) throw new Error('选区太小，请重新框选。');
  return { x, y, width, height };
}

class CaptureService {
  constructor(options) {
    Object.assign(this, options);
    this.overlays = new Map();
    this.result = null;
    this.state = {};
    this.generation = 0;
    this.capturing = false;
    this.translating = false;
    this.getDisplays = () => screen.getAllDisplays();
    this.getSources = options => desktopCapturer.getSources(options);
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(event, () => this.cancelCapture());
    for (const [channel, fn] of Object.entries({
      init: (event) => this.initial(event),
      select: (event, rect) => this.select(event, rect),
      cancel: () => this.cancelCapture(),
      close: () => this.result?.destroy(),
      retry: () => this.start(),
      translate: (_event, text, direction, engine) => this.translate(text, direction, engine),
      'cancel-work': () => this.cancelWork(),
      copy: (_event, text) => { if (typeof text !== 'string' || text.length > 20000) throw new Error('复制内容过长。'); clipboard.writeText(text); },
      pin: (_event, value) => { if (typeof value !== 'boolean') throw new Error('Invalid pin'); this.result.setAlwaysOnTop(value); },
      open: (_event, text, settings) => { this.validateText(text); this.openMain(text, settings === true ? 'engines' : false); this.result?.destroy(); },
      speech: (_event, text, language) => { this.validateText(text); return this.speak(text, language); },
      'stop-speech': () => this.stopSpeech(),
    })) ipcMain.handle(`capture:${channel}`, (event, ...args) => {
      const overlay = this.overlays.has(event.sender.id);
      const result = this.result && !this.result.isDestroyed() && event.sender === this.result.webContents;
      if ((!overlay && !result) || event.senderFrame !== event.sender.mainFrame ||
          (overlay && !['init', 'select', 'cancel'].includes(channel)) ||
          (result && ['select', 'cancel'].includes(channel))) throw new Error('无效的截图请求。');
      return fn(event, ...args);
    });
  }
  validateText(text) { if (typeof text !== 'string' || text.length > 5000) throw new Error('截图文字不能超过 5,000 字。'); }
  createWindow(bounds, overlay = false) {
    const win = new BrowserWindow({ ...bounds, frame: false, show: false, resizable: !overlay,
      minWidth: overlay ? undefined : 380, minHeight: overlay ? undefined : 400,
      skipTaskbar: overlay, alwaysOnTop: true, title: 'BestDict · 截图翻译',
      backgroundColor: overlay ? '#121b2a' : nativeTheme.shouldUseDarkColors ? '#101b2c' : '#e9f1fb',
      webPreferences: { preload: path.join(__dirname, 'capture-preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    win.setMenu(null);
    if (overlay) win.setAlwaysOnTop(true, 'screen-saver');
    else if (!nativeTheme.prefersReducedTransparency) { try { win.setBackgroundMaterial('acrylic'); } catch {} }
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    return win;
  }
  async load(win) { await win.loadURL(this.url() + '#capture'); }
  initial(event) {
    const overlay = this.overlays.get(event.sender.id);
    return { locale: this.settings().locale, dark: nativeTheme.shouldUseDarkColors,
      ...(overlay ? { mode: 'select', image: overlay.image.toDataURL() } : { mode: 'result', ...this.state, engines: this.engines() }) };
  }
  publish(update) {
    this.state = { ...this.state, ...update };
    if (this.result && !this.result.isDestroyed()) this.result.webContents.send('capture:state', this.state);
  }
  clearOverlays() {
    const overlays = [...this.overlays.values()];
    this.overlays.clear();
    for (const { win } of overlays) if (!win.isDestroyed()) win.destroy();
  }
  async start() {
    if (process.platform !== 'win32') throw new Error('截图翻译目前仅支持 Windows。');
    if (this.capturing) return;
    if (!this.ocr.status().ready) { this.openMain('', 'capture'); return; }
    this.cancelWork();
    const generation = ++this.generation;
    this.capturing = true;
    this.restore = this.hideMain();
    if (this.result && !this.result.isDestroyed()) this.result.hide();
    try {
      // Let DWM compose the desktop after hiding our windows, then freeze before overlays exist.
      await new Promise(resolve => setTimeout(resolve, 180));
      const displays = this.getDisplays();
      if (!displays.length) throw new Error('没有可用的显示器，请连接桌面后重试。');
      const sources = await this.getSources({ types: ['screen'], thumbnailSize: {
        width: Math.max(...displays.map(d => Math.ceil(d.size.width * d.scaleFactor))),
        height: Math.max(...displays.map(d => Math.ceil(d.size.height * d.scaleFactor))),
      } });
      if (generation !== this.generation) return;
      const loads = [];
      for (const display of displays) {
        const source = sources.find(s => s.display_id === String(display.id));
        if (!source || source.thumbnail.isEmpty()) throw new Error('无法截取屏幕，请重试。');
        const image = nativeImage.createFromBuffer(source.thumbnail.toPNG());
        const win = this.createWindow(display.bounds, true);
        const bounds = win.getBounds();
        if (bounds.width !== display.bounds.width || bounds.height !== display.bounds.height) win.setBounds({ ...display.bounds,
          width: 2 * display.bounds.width - bounds.width, height: 2 * display.bounds.height - bounds.height });
        this.overlays.set(win.webContents.id, { win, image, display });
        const id = win.webContents.id;
        win.on('closed', () => { if (this.overlays.has(id)) this.cancelCapture(); });
        win.webContents.on('render-process-gone', () => this.cancelCapture());
        loads.push(this.load(win));
      }
      await Promise.all(loads);
      if (generation !== this.generation) return;
      for (const { win } of this.overlays.values()) win.showInactive();
      const active = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      [...this.overlays.values()].find(o => o.display.id === active.id)?.win.focus();
    } catch (error) { if (generation === this.generation) { this.cancelCapture(); throw error; } }
  }
  cancelCapture() {
    if (!this.capturing) return;
    this.generation++;
    this.clearOverlays();
    this.capturing = false;
    this.restore?.();
    if (this.result && !this.result.isDestroyed()) this.result.show();
  }
  async select(event, rect) {
    const overlay = this.overlays.get(event.sender.id);
    const crop = overlay.image.crop(cropRect(rect, overlay.image.getSize()));
    const image = crop.toPNG().toString('base64');
    if (image.length > 64 * 1024 * 1024) throw new Error('截图过大，请缩小选区。');
    const area = overlay.display.workArea;
    this.clearOverlays();
    this.capturing = false;
    if (this.result && !this.result.isDestroyed()) this.result.destroy();
    const width = Math.min(560, area.width), height = Math.min(680, area.height);
    this.result = this.createWindow({ width, height, x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2) });
    this.state = { image: crop.resize({ width: Math.min(720, crop.getSize().width) }).toDataURL(), text: '', phase: 'recognizing', error: '', translation: null };
    const resultWindow = this.result;
    resultWindow.webContents.on('render-process-gone', () => resultWindow.destroy());
    this.result.on('closed', () => {
      if (this.result !== resultWindow) return;
      if (!this.capturing) this.cancelWork();
      this.result = null; this.state = {};
    });
    const generation = ++this.generation;
    await this.load(this.result);
    if (generation !== this.generation || resultWindow.isDestroyed()) return;
    this.result.show();
    this.result.focus();
    try {
      const result = await this.ocr.recognize(image);
      if (generation !== this.generation) return;
      this.publish({ text: result.text, lowConfidence: result.lines.some(l => l.confidence < .8), phase: 'ready', error: result.text ? '' : '未识别到文字，请重新截图。' });
    } catch (error) { if (generation === this.generation) this.publish({ phase: 'ready', error: error.message }); }
  }
  async translate(text, direction, engine) {
    this.validateText(text);
    if (!text.trim() || !['auto', 'en-zh', 'zh-en'].includes(direction) || !['auto', 'argos', 'hy'].includes(engine)) throw new Error('无效的翻译请求。');
    this.cancelWork();
    const generation = ++this.generation;
    this.translating = true;
    try {
      const result = await this.runTranslation(text, direction, engine);
      if (generation !== this.generation) throw new Error('请求已取消');
      return result;
    } finally { if (generation === this.generation) this.translating = false; }
  }
  cancelWork() {
    this.generation++;
    if (this.ocr.worker.pending.size) this.ocr.worker.stop();
    if (this.translating) this.cancelTranslation();
    this.translating = false;
    if (this.state.phase === 'recognizing') this.publish({ phase: 'ready', error: '识别已取消，请重新截图。' });
    this.stopSpeech();
  }
  stop() { this.restore = null; this.cancelCapture(); this.cancelWork(); this.result?.destroy(); this.ocr.stop(); }
}
module.exports = { CaptureService, cropRect };
