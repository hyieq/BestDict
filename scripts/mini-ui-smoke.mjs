import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { closeElectronTest } from './close-electron-test.mjs';

const env = { ...process.env, BESTDICT_TEST: '1', BESTDICT_TEST_SHORTCUT: 'Control+Alt+Shift+F10' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.BESTDICT_LIBRARY;
const executablePath = process.env.BESTDICT_TEST_EXE;
const desktop = await electron.launch({ executablePath, args: executablePath ? [] : ['.'], env });
const errors = [];
const output = path.resolve('test-results/mini');
await mkdir(output, { recursive: true });
try {
  const page = await desktop.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.getByText('离线资源已就绪').waitFor();
  const original = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized()), false, 'Initial window must have a normal frame that mini mode can restore.');
  assert.equal(await desktop.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Control+Alt+Shift+F9')), true);
  await page.getByRole('button', { name: '迷你模式', exact: true }).click();
  const mini = page.getByTestId('mini-window');
  await mini.waitFor();
  const input = mini.locator('textarea');
  assert.equal(await input.evaluate(node => node === document.activeElement), true);
  await page.waitForFunction(() => innerHeight < 180);
  await input.fill('serendipity');
  await input.press('Enter');
  await page.getByTestId('mini-word').filter({ hasText: 'serendipity' }).waitFor();
  await page.waitForFunction(() => innerHeight > 220);
  const state = await desktop.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    return { bounds: w.getBounds(), pinned: w.isAlwaysOnTop(), resizable: w.isResizable() };
  });
  assert.ok(Math.abs(state.bounds.width - 420) <= 4);
  assert.equal(state.pinned, false);
  assert.equal(state.resizable, true);
  await page.getByRole('button', { name: '复制释义', exact: true }).click();
  assert.match(await desktop.evaluate(({ clipboard }) => clipboard.readText()), /serendipity/);
  await page.getByRole('button', { name: '固定置顶', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.bestdict.getWindowMode().then(mode => mode.pinned));
  for (let attempt = 0; attempt < 20 && !await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isAlwaysOnTop()); attempt++) {
    await page.waitForTimeout(50);
  }
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isAlwaysOnTop()), true);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('blur'));
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true);

  async function capture(name) {
    await page.evaluate(() => { for (const animation of document.getAnimations()) if (animation.effect?.getTiming().iterations !== Infinity) animation.finish(); });
    const png = await desktop.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
    await writeFile(path.join(output, name), Buffer.from(png, 'base64'));
  }
  await capture('light.png');
  // Actual speech service/cache and playback; only inference returns silent PCM.
  await desktop.evaluate(() => {
    const { resources, speech } = globalThis.__bestdictNative.getServices();
    resources.kokoroStatus = () => ({ ready: true, sha256: 'mini-test-model' });
    const pcm = Buffer.alloc(44 + 16000 * 2 * 3);
    pcm.write('RIFF'); pcm.writeUInt32LE(pcm.length - 8, 4); pcm.write('WAVEfmt ', 8);
    pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22);
    pcm.writeUInt32LE(16000, 24); pcm.writeUInt32LE(32000, 28); pcm.writeUInt16LE(2, 32);
    pcm.writeUInt16LE(16, 34); pcm.write('data', 36); pcm.writeUInt32LE(pcm.length - 44, 40);
    globalThis.__miniGenerations = 0;
    speech.worker.request = async method => { if (method === 'prepare') return { ready: true }; globalThis.__miniGenerations++; return { audio: pcm.toString('base64'), engine: 'kokoro' }; };
  });
  await page.evaluate(async () => {
    const settings = await window.bestdict.getSettings();
    await window.bestdict.setSettings({ speech: { ...settings.speech, engine: 'kokoro' } });
    window.__miniPlayed = 0;
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { window.__miniPlayed++; this.muted = true; return play.call(this); };
  });
  for (const count of [1, 2]) {
    await mini.getByRole('button', { name: '播放发音' }).click();
    await page.waitForFunction(count => window.__miniPlayed === count, count);
    await mini.getByRole('button', { name: '停止发音' }).click();
  }
  assert.equal(await desktop.evaluate(() => globalThis.__miniGenerations), 1);
  const miniPosition = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  await page.getByRole('button', { name: '展开主窗口', exact: true }).click();
  await page.getByTestId('entry-word').filter({ hasText: 'serendipity' }).waitFor();
  assert.equal(await page.locator('.search-box textarea').inputValue(), 'serendipity');
  const restored = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  console.log('Window restoration evidence:', JSON.stringify({ original, restored, miniPosition,
    native: await desktop.evaluate(({ screen }) => ({ displays: screen.getAllDisplays(), savedBounds: globalThis.__bestdictNative.readSettings().bounds })) }));
  for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(restored[key] - original[key]) <= 1, 'restore ' + key);
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isAlwaysOnTop()), false);
  await desktop.evaluate(() => globalThis.__bestdictNative.toggleMini());
  await mini.waitFor();
  const returnedPosition = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  assert.equal(returnedPosition.x, miniPosition.x);
  assert.equal(returnedPosition.y, miniPosition.y);
  await page.getByRole('button', { name: '固定置顶', exact: true }).click();
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('blur'));
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
  await desktop.evaluate(() => globalThis.__bestdictNative.toggleMini());
  await input.fill('A long sentence that should never start a translation model in the mini window.');
  await input.press('Enter');
  await page.getByRole('button', { name: '进入主窗口翻译' }).waitFor();
  assert.equal(await mini.locator('.mini-word').count(), 0);
  await input.fill('');
  await page.waitForFunction(() => innerHeight < 180);
  await input.press('Escape');
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
  await desktop.evaluate(() => globalThis.__bestdictNative.toggleMain());
  await page.locator('.titlebar').waitFor();

  // Conflict must leave the original registered shortcut usable.
  await desktop.evaluate(({ globalShortcut }) => globalShortcut.register('Control+Alt+Shift+F6', () => {}));
  const rejected = await page.evaluate(async () => {
    try { await window.bestdict.setSettings({ miniShortcut: 'Control+Alt+Shift+F6' }); return false; } catch { return true; }
  });
  assert.equal(rejected, true);
  assert.equal(await desktop.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Control+Alt+Shift+F9')), true);
  assert.equal((await page.evaluate(() => window.bestdict.getSettings())).miniShortcut, 'Control+Alt+Shift+F9');
  await desktop.evaluate(({ globalShortcut }) => globalShortcut.unregister('Control+Alt+Shift+F6'));
  await page.evaluate(() => window.bestdict.setSettings({ miniShortcut: 'Control+Alt+Shift+F7', miniHideOnBlur: false, theme: 'dark', locale: 'en' }));
  assert.equal(await desktop.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Control+Alt+Shift+F7')), true);
  assert.equal(await desktop.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Control+Alt+Shift+F9')), false);
  await page.reload();
  await page.locator('html[data-theme=dark]').waitFor();
  await page.getByRole('button', { name: 'Mini mode', exact: true }).click();
  await input.fill('resilience');
  await page.getByTestId('mini-word').filter({ hasText: 'resilience' }).waitFor();
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('blur'));
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true);
  await capture('dark.png');
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.5));
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight), true);
  assert.equal(await page.getByRole('button', { name: 'Full definition' }).evaluate(el => el.getBoundingClientRect().bottom <= innerHeight), true);
  await capture('zoom.png');
  assert.deepEqual(errors, []);
  // A final resize can leave a pending bounds save when the native window closes.
  // Keep the main process alive past the debounce to exercise that teardown race.
  await desktop.evaluate(({ BrowserWindow }) => {
    globalThis.__miniShutdownErrors = [];
    process.on('uncaughtExceptionMonitor', error => {
      console.error('Mini shutdown exception:', error.stack);
      globalThis.__miniShutdownErrors.push(error.message);
    });
    const nativeWindow = BrowserWindow.getAllWindows()[0];
    const bounds = nativeWindow.getBounds();
    nativeWindow.setBounds({ ...bounds, width: bounds.width + 1 });
    nativeWindow.destroy();
  });
  await new Promise(resolve => setTimeout(resolve, 650));
  assert.deepEqual(await desktop.evaluate(() => globalThis.__miniShutdownErrors), []);
} finally {
  await desktop.evaluate(({ app }) => {
    app.once('before-quit', () => console.log('Mini shutdown: before-quit'));
    app.once('will-quit', () => console.log('Mini shutdown: will-quit'));
  });
  await closeElectronTest(desktop);
}
console.log('Mini UI passed: real lookup, copy, shared query, bounds, pin, blur, shortcuts, conflict, English, dark, zoom and graceful quit.');
