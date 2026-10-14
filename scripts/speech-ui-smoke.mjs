import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const env = { ...process.env, BESTDICT_TEST: '1', BESTDICT_TEST_SHORTCUT: 'Control+Alt+Shift+F12' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.BESTDICT_LIBRARY;
const executablePath = process.env.BESTDICT_TEST_EXE;
const desktop = await electron.launch({ args: executablePath ? [] : ['.'], executablePath, cwd: process.cwd(), env });
try {
  const page = await desktop.firstWindow();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.getByText('离线资源已就绪').waitFor();
  await desktop.evaluate(() => {
    const { resources, translator, hy, speech } = globalThis.__bestdictNative.getServices();
    resources.argosStatus = () => ({ ready: true });
    resources.hyStatus = () => ({ ready: true });
    resources.install = () => { throw new Error('Unexpected automatic download'); };
    translator.request = async () => ({ text: '请在周五发送报告。', direction: 'en-zh', engine: 'Argos', cached: false });
    hy.translate = async () => ({ text: '请在周五之前发送报告。', direction: 'en-zh', engine: 'HY', cached: false });
    // Silent PCM goes through actual Blob/Audio playback without producing sound.
    const pcm = Buffer.alloc(44 + 16000 * 2 * 4);
    pcm.write('RIFF'); pcm.writeUInt32LE(pcm.length - 8, 4); pcm.write('WAVEfmt ', 8);
    pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22);
    pcm.writeUInt32LE(16000, 24); pcm.writeUInt32LE(32000, 28); pcm.writeUInt16LE(2, 32);
    pcm.writeUInt16LE(16, 34); pcm.write('data', 36); pcm.writeUInt32LE(pcm.length - 44, 40);
    globalThis.__speechTest = { pending: [], audio: pcm.toString('base64'), requests: [], cancels: 0 };
    globalThis.__originalSynthesize = speech.synthesize.bind(speech);
    globalThis.__originalCancel = speech.cancel.bind(speech);
    speech.synthesize = (text, language, settings) => new Promise(resolve => {
      globalThis.__speechTest.requests.push({ text, language, settings });
      globalThis.__speechTest.pending.push(resolve);
    });
    speech.cancel = async () => { globalThis.__speechTest.cancels++; };
  });
  await page.evaluate(() => window.bestdict.setSettings({ translationEngine: 'argos' }));
  await page.reload();
  await page.getByText('离线资源已就绪').waitFor();
  await page.evaluate(() => {
    window.__played = 0;
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { window.__played++; window.__lastSpeechAudio = this; this.muted = true; return play.call(this); };
  });
  const input = page.getByRole('textbox', { name: '输入单词或句子' });
  await input.fill('Please send the report on Friday.');
  await page.getByTestId('translation-result').waitFor();
  const basic = page.locator('.translation-panel');
  const release = () => desktop.evaluate(() => {
    const state = globalThis.__speechTest;
    state.pending.shift()({ audio: state.audio, engine: 'system' });
  });
  await basic.getByRole('button', { name: '播放发音' }).click();
  await basic.getByRole('button', { name: '停止发音' }).click();
  await release();
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.__played), 0, 'Cancelled synthesis never starts playback');
  await basic.getByRole('button', { name: '播放发音' }).click();
  await release();
  await page.waitForFunction(() => window.__played === 1);
  await basic.getByRole('button', { name: '停止发音' }).click();
  await basic.getByRole('button', { name: '播放发音' }).waitFor();
  await basic.getByRole('button', { name: '播放发音' }).click();
  await input.fill('apple');
  await release();
  await page.getByTestId('entry-word').waitFor();
  assert.equal(await page.evaluate(() => window.__played), 1, 'Changing query discards pending audio');
  await input.fill('Please send the report on Friday.');
  await page.getByTestId('translation-result').waitFor();
  await page.getByRole('button', { name: 'AI 翻译', exact: true }).click();
  const ai = page.getByTestId('ai-panel');
  await page.getByTestId('ai-translation-result').waitFor();
  await basic.getByRole('button', { name: '播放发音' }).click();
  await release();
  await page.waitForFunction(() => window.__played === 2);
  await ai.getByRole('button', { name: '播放发音' }).click();
  await basic.getByRole('button', { name: '播放发音' }).waitFor();
  await release();
  await page.waitForFunction(() => window.__played === 3);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await ai.getByRole('button', { name: '播放发音' }).waitFor();
  await page.getByRole('tab', { name: '发音', exact: true }).click();
  await page.locator('#system-en').waitFor();
  await page.locator('#speech-engine').selectOption('system');
  await page.getByRole('slider', { name: /语速/ }).fill('1.3');
  await page.locator('#system-en').selectOption({ index: 1 });
  const englishPreview = page.getByRole('group', { name: '试听英文' });
  await englishPreview.getByRole('button', { name: '播放发音' }).click();
  const previewRequest = await desktop.evaluate(() => globalThis.__speechTest.requests.at(-1));
  assert.equal(previewRequest.language, 'en');
  assert.equal(previewRequest.settings.rate, 1.3);
  assert.equal(previewRequest.settings.engine, 'system');
  assert.ok(previewRequest.settings.systemVoices.en);
  assert.equal((await page.evaluate(() => window.bestdict.getSettings())).speech.rate, 1, 'Preview does not save draft settings');
  await englishPreview.getByRole('button', { name: '停止发音' }).click();
  await release();
  assert.equal(await page.evaluate(() => window.__played), 3, 'Stopped preview never plays late');
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/speech-settings.png' });
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  const settings = await page.evaluate(() => window.bestdict.getSettings());
  assert.equal(settings.speech.rate, 1.3);
  assert.equal(settings.speech.engine, 'system');
  assert.ok(settings.speech.systemVoices.en);
  await ai.getByRole('button', { name: '播放发音' }).click();
  await release();
  await page.waitForFunction(() => window.__played === 4);
  try {
    // Hosted Macs can advance their virtual sound device slower than wall time.
    // Still require the real ended event; do not simulate completion or skip it.
    await ai.getByRole('button', { name: '播放发音' }).waitFor({ timeout: process.platform === 'darwin' && process.env.CI ? 30000 : 8000 });
  } catch (error) {
    console.log('Playback evidence:', await page.evaluate(() => {
      const audio = window.__lastSpeechAudio;
      return { time: audio?.currentTime, duration: audio?.duration, paused: audio?.paused,
        ended: audio?.ended, readyState: audio?.readyState, error: audio?.error?.message, hidden: document.hidden };
    }));
    throw error;
  }
  await ai.getByRole('button', { name: '播放发音' }).click();
  await page.evaluate(() => window.bestdict.hide());
  await release();
  await desktop.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].show(); });
  await ai.getByRole('button', { name: '播放发音' }).waitFor();
  assert.equal(await page.evaluate(() => window.__played), 4, 'Hiding the window discards pending audio');
  assert.equal(await page.getByRole('slider').count(), 0, 'Voice controls stay inside settings');
  await page.screenshot({ path: 'test-results/speech-results.png' });
  await input.fill('apple');
  await page.getByTestId('entry-word').filter({ hasText: 'apple' }).waitFor();
  const word = page.locator('.entry-word-row');
  await word.getByRole('button', { name: '播放发音' }).click();
  const wordRequest = await desktop.evaluate(() => globalThis.__speechTest.requests.at(-1));
  assert.equal(wordRequest.text, 'apple');
  assert.equal(wordRequest.language, 'en');
  await release();
  await page.waitForFunction(() => window.__played === 5);
  await word.getByRole('button', { name: '停止发音' }).click();
  await word.getByRole('button', { name: '播放发音' }).waitFor();
  await page.screenshot({ path: 'test-results/speech-word.png' });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('tab', { name: '发音', exact: true }).click();
  await page.getByRole('group', { name: '试听中文' }).getByRole('button', { name: '播放发音' }).click();
  assert.equal(await desktop.evaluate(() => globalThis.__speechTest.requests.at(-1).language), 'zh');
  await page.getByRole('slider', { name: /语速/ }).fill('1.5');
  await release();
  assert.equal(await page.evaluate(() => window.__played), 5, 'Editing preview preferences discards old audio');
  await page.getByRole('group', { name: '试听英文' }).getByRole('button', { name: '播放发音' }).click();
  await page.getByRole('button', { name: '关闭设置' }).click();
  await release();
  assert.equal(await page.evaluate(() => window.__played), 5, 'Closing settings discards pending preview');
  assert.equal((await page.evaluate(() => window.bestdict.getSettings())).speech.rate, 1.3, 'Closing settings discards unsaved rate');
  // Use the real service and disk cache; only model inference is replaced by silent WAV audio.
  await desktop.evaluate(() => {
    const { resources, speech } = globalThis.__bestdictNative.getServices();
    speech.synthesize = globalThis.__originalSynthesize;
    speech.cancel = globalThis.__originalCancel;
    resources.kokoroStatus = () => ({ ready: true, sha256: 'cache-ui-model' });
    globalThis.__cacheGenerations = 0;
    speech.worker.request = async () => { globalThis.__cacheGenerations++; return { audio: globalThis.__speechTest.audio, engine: 'kokoro' }; };
  });
  await page.evaluate(async () => {
    const current = await window.bestdict.getSettings();
    await window.bestdict.setSettings({ speech: { ...current.speech, engine: 'kokoro', rate: 1 } });
  });
  await page.reload();
  await page.evaluate(() => {
    window.__cachePlayed = 0;
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { window.__cachePlayed++; this.muted = true; return play.call(this); };
  });
  await input.fill('apple');
  await page.getByTestId('entry-word').filter({ hasText: 'apple' }).waitFor();
  for (const count of [1, 2]) {
    await word.getByRole('button', { name: '播放发音' }).click();
    await page.waitForFunction(count => window.__cachePlayed === count, count);
    await word.getByRole('button', { name: '停止发音' }).click();
  }
  assert.equal(await desktop.evaluate(() => globalThis.__cacheGenerations), 1, 'Replay skips model inference');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('tab', { name: '发音', exact: true }).click();
  const cache = page.getByTestId('speech-cache');
  await cache.getByText(/1 条 ·/).waitFor();
  await page.locator('#kokoro-zh:not([disabled])').waitFor();
  await cache.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/speech-cache-settings.png', animations: 'disabled' });
  await cache.getByRole('button', { name: '清理音频缓存', exact: true }).click();
  await cache.getByText('音频缓存已清理。').waitFor();
  assert.equal((await page.evaluate(() => window.bestdict.getSpeechCache())).count, 0);
  assert.equal(await cache.getByRole('button', { name: '清理音频缓存', exact: true }).isDisabled(), true);
  assert.equal((await page.evaluate(() => window.bestdict.getResources())).kokoro.ready, true);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(780, 580));
  await cache.scrollIntoViewIfNeeded();
  const compact = await cache.boundingBox();
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.ok(compact.x >= 0 && compact.x + compact.width <= viewport.width, 'Cache controls fit the compact window');
  await page.evaluate(() => window.bestdict.setSettings({ locale: 'en' }));
  await page.getByRole('button', { name: '关闭设置' }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Speech', exact: true }).click();
  await page.getByTestId('speech-cache').getByText(/0 clips ·/).waitFor();
  await page.getByTestId('speech-cache').getByRole('button', { name: 'Clear audio cache', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await page.evaluate(() => window.bestdict.setSettings({ locale: 'zh-CN' }));
  await page.reload();
  await page.evaluate(() => {
    window.__cachePlayed = 2;
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { window.__cachePlayed++; this.muted = true; return play.call(this); };
  });
  await input.fill('apple');
  await page.getByTestId('entry-word').filter({ hasText: 'apple' }).waitFor();
  await word.getByRole('button', { name: '播放发音' }).click();
  await page.waitForFunction(() => window.__cachePlayed === 3);
  assert.equal(await desktop.evaluate(() => globalThis.__cacheGenerations), 2, 'Playback regenerates after clearing');
  await word.getByRole('button', { name: '停止发音' }).click();
  assert.deepEqual(errors, []);
  console.log('Speech UI passed: playback/cancellation/previews, disk cache replay without inference, cache statistics and clearing, model preserved, regeneration after clearing.');
} finally { await desktop.close(); }
