import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile, copyFile, link } from 'node:fs/promises';
import path from 'node:path';

const env = { ...process.env, BESTDICT_TEST: '1', BESTDICT_TEST_SHORTCUT: 'Control+Alt+Shift+F10' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.BESTDICT_LIBRARY;
const executablePath = process.env.BESTDICT_TEST_EXE;
const desktop = await electron.launch({ executablePath, args: executablePath ? [] : ['.'], env });
const output = path.resolve('test-results/capture');
await mkdir(output, { recursive: true });
const errors = [];
try {
  await desktop.evaluate(({ clipboard }) => { globalThis.captureClipboard = { text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(), image: clipboard.readImage() }; });
  const main = await desktop.firstWindow();
  main.on('pageerror', e => errors.push(e.message));
  await main.getByText('离线资源已就绪').waitFor();
  assert.equal(await desktop.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Control+Alt+Shift+F8')), true);
  await main.getByRole('button', { name: '截图翻译', exact: true }).click();
  await main.getByTestId('resource-ocr').waitFor();
  assert.equal(await main.evaluate(() => window.bestdict.getOCR()).then(s => s.ready), false);
  await main.getByRole('button', { name: '关闭设置' }).click();
  // Use pinned, real weights in an isolated library; no user settings or screenshots are saved.
  const model = await desktop.evaluate(() => { const { ocr } = globalThis.__bestdictNative.getServices(); return { directory: ocr.directory, files: ocr.spec.files }; });
  await mkdir(model.directory, { recursive: true });
  for (const file of model.files) await copyFile(path.resolve('runtime/python/Lib/site-packages/rapidocr/models', file.name), path.join(model.directory, file.name));
  console.log('Models ready in isolated library.');
  await desktop.evaluate(async ({ BrowserWindow, screen }) => {
    const display = screen.getPrimaryDisplay();
    const bounds = { x: display.workArea.x + 30, y: display.workArea.y + 30, width: 780, height: 460 };
    const fixture = new BrowserWindow({ ...bounds, frame: false, alwaysOnTop: true, webPreferences: { sandbox: true } });
    await fixture.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<body style="margin:0;padding:48px;background:white;color:#111;font:28px Arial"><p>Hello, welcome to BestDict.</p><p>Learning a language opens a new world.</p><p style="font-family:Microsoft YaHei">你好，欢迎使用离线词典。</p></body>'));
    globalThis.captureFixture = fixture;
    globalThis.captureBounds = bounds;
    const { capture } = globalThis.__bestdictNative.getServices();
    globalThis.captureNative = screen.getAllDisplays().length > 0;
    if (!globalThis.captureNative) {
      // CI/service desktops may expose no monitors. Use real renderer pixels as a screen fixture.
      const d = { id: 999, bounds: { x: 0, y: 0, width: 780, height: 460 }, size: { width: 780, height: 460 }, workArea: { x: 0, y: 0, width: 1024, height: 768 }, scaleFactor: 1 };
      capture.getDisplays = () => [d];
      capture.getSources = async () => [{ display_id: '999', thumbnail: await fixture.webContents.capturePage() }];
      globalThis.captureBounds = { x: 0, y: 0, width: 780, height: 460 };
    }
  });
  const nativeCapture = await desktop.evaluate(() => globalThis.captureNative);
  console.log('Native desktop available:', nativeCapture);
  async function selectFixture() {
    console.log('Capturing desktop.');
    const failure = await desktop.evaluate(async () => { try { await globalThis.__bestdictNative.getServices().capture.start(); } catch (e) { return e.stack; } });
    assert.equal(failure, undefined);
    const overlay = await desktop.waitForEvent('window', { predicate: page => page.url().includes('#capture'), timeout: 1000 }).catch(() => null);
    const pages = desktop.windows();
    const selection = overlay || (await Promise.all(pages.map(async p => ({ p, mode: await p.evaluate(() => window.capture?.init()).catch(() => null) })))).find(x => x.mode?.mode === 'select')?.p;
    assert.ok(selection);
    await selection.getByTestId('capture-selection').waitFor();
    const rect = await desktop.evaluate(({ screen }) => {
      const d = globalThis.__bestdictNative.getServices().capture.getDisplays()[0], b = globalThis.captureBounds;
      return { x: (b.x - d.bounds.x + 10) / d.bounds.width, y: (b.y - d.bounds.y + 10) / d.bounds.height,
        width: (b.width - 20) / d.bounds.width, height: (b.height - 20) / d.bounds.height };
    });
    // Exercise actual pointer selection using viewport-scaled display coordinates.
    const size = await selection.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    await selection.mouse.move(rect.x * size.w, rect.y * size.h);
    await selection.mouse.down();
    await selection.mouse.move((rect.x + rect.width) * size.w, (rect.y + rect.height) * size.h, { steps: 5 });
    await selection.mouse.up();
    let result;
    for (let i = 0; i < 60; i++) {
      for (const p of desktop.windows()) if (await p.getByTestId('capture-result').count().catch(() => 0)) result = p;
      if (result) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(result);
    result.on('pageerror', e => errors.push(e.message));
    await result.waitForFunction(() => document.querySelector('#ocr-text')?.value.includes('BestDict') || document.querySelector('[role=alert]'), undefined, { timeout: 90000 });
    console.log('OCR:', await result.locator('#ocr-text').inputValue(), await result.locator('[role=alert]').allTextContents());
    return result;
  }
  let result = await selectFixture();
  const text = await result.locator('#ocr-text').inputValue();
  assert.match(text, /Learning a language/);
  assert.match(text, /你好/);
  await result.getByRole('button', { name: '复制原文', exact: true }).click();
  assert.equal(await desktop.evaluate(({ clipboard }) => clipboard.readText()), text);
  await result.screenshot({ path: path.join(output, 'ocr-result.png') });
  if (process.env.BESTDICT_REAL_CAPTURE === '1') {
    const hy = await desktop.evaluate(() => { const { resources } = globalThis.__bestdictNative.getServices(); return { library: resources.library, filename: resources.hySpec.filename }; });
    const target = path.join(hy.library, 'hy-mt2');
    await mkdir(target, { recursive: true });
    for (const file of ['metadata.json', hy.filename]) {
      const source = path.resolve('.cache/validation-library/hy-mt2', file);
      await link(source, path.join(target, file)).catch(() => copyFile(source, path.join(target, file)));
    }
    await main.evaluate(() => window.bestdict.setSettings({ translationEngine: 'hy' }));
    // Use the original production route and the installed real model, without replacing inference.
    await result.reload();
    await result.getByRole('combobox', { name: '翻译方向' }).selectOption('en-zh');
    await result.locator('#ocr-text').fill('Learning a language opens a new world.');
    await result.getByRole('button', { name: '翻译', exact: true }).click();
    await result.locator('.capture-translated').waitFor({ timeout: 180000 });
    const realText = await result.locator('.capture-translated').innerText();
    assert.match(realText, /语言/);
    assert.match(realText, /世界/);
    await result.screenshot({ path: path.join(output, 'real-hy-translation.png') });
    console.log('Real HY translation:', realText);
  }
  // Inject only translation inference, leaving capture, OCR, IPC, editing and windows real.
  await desktop.evaluate(() => {
    const { capture } = globalThis.__bestdictNative.getServices();
    capture.engines = () => ({ hy: true, argos: false });
    capture.runTranslation = async text => ({ text: '你好，欢迎使用 BestDict。\n学习语言，探索新的世界。', direction: 'en-zh', engine: 'Test translator', cached: false });
  });
  await result.getByRole('button', { name: '关闭', exact: true }).click();
  result = await selectFixture();
  await result.getByText('学习语言，探索新的世界。', { exact: false }).waitFor();
  await result.locator('#ocr-text').fill('A changed sentence.');
  assert.equal(await result.locator('.capture-translated').count(), 0);
  await result.getByRole('button', { name: '翻译', exact: true }).click();
  await result.locator('.capture-translated').waitFor();
  await desktop.evaluate(() => globalThis.__bestdictNative.getServices().capture.publish({ engines: { hy: false, argos: true } }));
  await result.getByText('基础翻译', { exact: true }).waitFor();
  await result.locator('.capture-translated').waitFor();
  assert.equal(await result.locator('#ocr-text').inputValue(), 'A changed sentence.', 'Changing provider retains the edited OCR text.');
  await desktop.evaluate(() => globalThis.__bestdictNative.getServices().capture.publish({ engines: { hy: true, argos: false } }));
  await result.getByText('混元 AI', { exact: true }).waitFor();
  await result.locator('.capture-translated').waitFor();
  await result.getByRole('button', { name: '复制译文', exact: true }).click();
  assert.match(await desktop.evaluate(({ clipboard }) => clipboard.readText()), /你好/);
  await result.getByRole('button', { name: '置顶', exact: true }).click();
  assert.equal(await desktop.evaluate(() => globalThis.__bestdictNative.getServices().capture.result.isAlwaysOnTop()), false);
  await result.screenshot({ path: path.join(output, 'translation-result.png') });
  // Actual capture speech IPC and shared streaming player; only inference is silent.
  await desktop.evaluate(() => {
    const { resources, speech } = globalThis.__bestdictNative.getServices();
    resources.kokoroStatus = () => ({ ready: true, sha256: 'capture-speech-fixture' });
    const pcm = Buffer.alloc(16000 * 2);
    const wav = Buffer.alloc(44 + pcm.length * 2);
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
    globalThis.__captureSpeech = { completed: false };
    speech.worker.request = async (method, params, options) => {
      if (method === 'prepare') return { ready: true };
      const chunk = { pcm: pcm.toString('base64'), sampleRate: 16000, generationMs: 200 };
      options.onEvent({ ...chunk, sequence: 0 });
      await new Promise(resolve => { globalThis.__captureSpeech.complete = () => { options.onEvent({ ...chunk, sequence: 1 }); resolve(); }; });
      globalThis.__captureSpeech.completed = true;
      return { audio: wav.toString('base64'), engine: 'kokoro', streamed: true };
    };
  });
  await main.evaluate(async () => { const settings = await window.bestdict.getSettings(); await window.bestdict.setSettings({ speech: { ...settings.speech, engine: 'kokoro' } }); });
  await result.evaluate(() => {
    window.__captureSpeechChunks = 0;
    const gain = AudioContext.prototype.createGain;
    AudioContext.prototype.createGain = function () { const node = gain.call(this); node.gain.value = 0; return node; };
    const buffer = AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource = function () {
      const node = buffer.call(this), start = node.start.bind(node);
      node.start = (...args) => { window.__captureSpeechChunks++; start(...args); };
      return node;
    };
  });
  await result.waitForTimeout(100);
  const voice = result.getByRole('button', { name: '播放译文', exact: true });
  await voice.click();
  await result.waitForFunction(() => window.__captureSpeechChunks === 1);
  assert.equal(await desktop.evaluate(() => globalThis.__captureSpeech.completed), false);
  await desktop.evaluate(() => globalThis.__captureSpeech.complete());
  await result.waitForFunction(() => document.querySelector('button[aria-label="播放译文"]')?.getAttribute('aria-pressed') === 'false');
  assert.equal(await result.evaluate(() => window.__captureSpeechChunks), 2);
  await assert.rejects(result.evaluate(() => window.capture.translate('x'.repeat(5001), 'auto', 'auto')), /5,000/);
  // Late translation must never overwrite a newer edit after cancellation.
  await desktop.evaluate(() => {
    globalThis.__bestdictNative.getServices().capture.runTranslation = () => new Promise(resolve => { globalThis.releaseCaptureTranslation = () => resolve({ text: 'STALE RESULT', direction: 'en-zh', engine: 'Test' }); });
  });
  await result.getByRole('button', { name: '翻译', exact: true }).click();
  await result.getByRole('button', { name: '取消', exact: true }).waitFor();
  await result.locator('#ocr-text').fill('A newer sentence after cancellation.');
  await desktop.evaluate(() => globalThis.releaseCaptureTranslation());
  await result.waitForTimeout(150);
  assert.equal(await result.getByText('STALE RESULT').count(), 0);
  await main.evaluate(() => window.bestdict.setSettings({ locale: 'en', theme: 'light' }));
  await result.reload();
  await result.getByRole('button', { name: 'Capture again' }).waitFor();
  await desktop.evaluate(() => globalThis.__bestdictNative.getServices().capture.result.webContents.setZoomFactor(1.5));
  await result.waitForTimeout(300);
  assert.equal(await result.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await result.getByRole('button', { name: 'Close', exact: true }).evaluate(el => el.getBoundingClientRect().right <= innerWidth), true);
  assert.equal(await result.locator('.capture-footer').evaluate(el => el.getBoundingClientRect().bottom <= innerHeight), true);
  const zoomImage = await desktop.evaluate(async () => (await globalThis.__bestdictNative.getServices().capture.result.webContents.capturePage()).toPNG().toString('base64'));
  await writeFile(path.join(output, 'english-zoom.png'), Buffer.from(zoomImage, 'base64'));
  await desktop.evaluate(() => globalThis.__bestdictNative.getServices().capture.result.webContents.setZoomFactor(1));
  await result.locator('#ocr-text').fill('A changed sentence.');
  await main.evaluate(() => window.bestdict.setSettings({ locale: 'zh-CN' }));
  await result.getByRole('button', { name: 'Full window', exact: true }).click();
  await main.waitForFunction(() => document.querySelector('textarea')?.value === 'A changed sentence.');
  // Escape restores the original window mode and leaves no capture windows behind.
  await main.evaluate(() => window.bestdict.startCapture());
  const overlays = await Promise.all(desktop.windows().map(async p => ({ p, s: await p.evaluate(() => window.capture?.init()).catch(() => null) })));
  await overlays.find(p => p.s?.mode === 'select').p.keyboard.press('Escape').catch(e => { if (!e.message.includes('closed')) throw e; });
  await main.waitForFunction(() => !document.hidden);
  assert.equal(await desktop.evaluate(() => globalThis.__bestdictNative.getServices().capture.overlays.size), 0);
  await main.evaluate(() => window.bestdict.uninstallOCR());
  assert.equal((await main.evaluate(() => window.bestdict.getOCR())).ready, false);
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ nativeCapture, text, checks: 'Screen selection, real OCR, copy, editing, translation routing, pin, open main, Escape, model removal', errors }, null, 2));
  console.log('Screenshot OCR desktop checks passed.');
} finally { await desktop.evaluate(({ app, clipboard }) => { if (globalThis.captureClipboard) clipboard.write(globalThis.captureClipboard); app.emit('before-quit'); app.exit(0); }).catch(() => {}); await desktop.close(); }
