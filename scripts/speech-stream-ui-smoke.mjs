import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { closeElectronTest } from './close-electron-test.mjs';

const real = process.env.BESTDICT_REAL_SPEECH === '1';
const long = real && process.env.BESTDICT_REAL_SPEECH_LONG === '1';
const selection = process.env.BESTDICT_REAL_SPEECH_CASE;
const env = { ...process.env, BESTDICT_TEST: '1', BESTDICT_TEST_SHORTCUT: 'Control+Alt+Shift+F12' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.BESTDICT_LIBRARY;
const executablePath = process.env.BESTDICT_TEST_EXE;
const desktop = await electron.launch({ args: executablePath ? [] : ['.'], executablePath, cwd: process.cwd(), env });
const report = { real, cases: [] };
try {
  const page = await desktop.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.getByText('离线资源已就绪').waitFor();
  await desktop.evaluate(async (_, { real, model }) => {
    const { resources, translator, speech } = globalThis.__bestdictNative.getServices();
    await speech.stop();
    resources.argosStatus = () => ({ ready: true });
    resources.kokoroStatus = () => ({ ready: true, sha256: 'stream-ui-model' });
    speech.worker.config.assets = model;
    globalThis.__streamTest = { text: '', direction: 'zh-en', pending: [], completed: 0, generations: 0, events: [], started: 0 };
    translator.request = async () => ({ text: globalThis.__streamTest.text, direction: globalThis.__streamTest.direction, engine: 'Argos', cached: false });
    const request = speech.worker.request.bind(speech.worker);
    speech.worker.request = async (method, params, options) => {
      if (real) {
        if (method !== 'synthesize') return request(method, params, options);
        globalThis.__streamTest.started = performance.now();
        globalThis.__streamTest.generations++;
        const result = await request(method, params, { ...options, onEvent: data => {
          globalThis.__streamTest.events.push({ time: performance.now() - globalThis.__streamTest.started, duration: Buffer.from(data.pcm, 'base64').length / 2 / data.sampleRate });
          options.onEvent(data);
        } });
        globalThis.__streamTest.completed++;
        globalThis.__streamTest.generationMs = performance.now() - globalThis.__streamTest.started;
        const wav = Buffer.from(result.audio, 'base64');
        globalThis.__streamTest.audioDuration = (wav.length - 44) / 2 / wav.readUInt32LE(24);
        return result;
      }
      if (method === 'prepare') return { ready: true };
      globalThis.__streamTest.generations++;
      return new Promise((resolve, reject) => globalThis.__streamTest.pending.push({ resolve, reject, onEvent: options.onEvent }));
    };
    const sampleRate = 16000;
    const pcm = Buffer.alloc(sampleRate * 2); // One second, muted real playback.
    const markers = [[32767, -32768, 1234, -4567], [12345, -12345, 1, -1], [2468, -2468, 32766, -32767]];
    const parts = markers.map(values => { const bytes = Buffer.from(pcm); values.forEach((value, index) => bytes.writeInt16LE(value, index * 2)); return bytes; });
    globalThis.__streamTest.parts = parts.map(bytes => bytes.toString('base64'));
    globalThis.__streamTest.chunk = { pcm: pcm.toString('base64'), sampleRate, generationMs: 200 };
    const wav = Buffer.alloc(44 + pcm.length * 3);
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28); wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
    parts.forEach((part, index) => part.copy(wav, 44 + index * pcm.length));
    globalThis.__streamTest.wav = wav.toString('base64');
  }, { real, model: path.resolve(process.env.BESTDICT_PROFILE_KOKORO || '.cache/speech-validation/kokoro/model') });
  await page.evaluate(async () => {
    const settings = await window.bestdict.getSettings();
    await window.bestdict.setSettings({ translationEngine: 'argos', speech: { ...settings.speech, engine: 'kokoro' } });
  });
  await page.reload();
  await page.getByText('离线资源已就绪').waitFor();
  await page.evaluate(() => {
    window.__streamPlayback = { schedules: [], starts: [], ended: 0, fullPlays: 0, clicks: [], sources: [] };
    const gain = AudioContext.prototype.createGain;
    AudioContext.prototype.createGain = function () { const output = gain.call(this); output.gain.value = 0; return output; };
    const buffer = AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource = function () {
      const node = buffer.call(this);
      const start = node.start.bind(node);
      const context = this;
      node.start = when => {
        window.__streamPlayback.schedules.push({ when, duration: node.buffer.duration, time: performance.now(), samples: Array.from(node.buffer.getChannelData(0).slice(0, 4)) });
        window.__streamPlayback.sources.push(node);
        node.addEventListener('ended', () => { window.__streamPlayback.ended++; });
        // Observe the actual audio clock reaching the scheduled start.
        const check = () => {
          if (context.state === 'closed') return;
          if (context.currentTime >= when) window.__streamPlayback.starts.push(performance.now());
          else setTimeout(check, 5);
        };
        setTimeout(check, 5);
        start(when);
      };
      return node;
    };
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { window.__streamPlayback.fullPlays++; this.muted = true; return play.call(this); };
    document.addEventListener('click', event => {
      if (event.target.closest('.translation-panel button[aria-label="播放发音"]')) window.__streamPlayback.clicks.push(performance.now());
    }, true);
  });
  const input = page.getByRole('textbox', { name: '输入单词或句子' });
  const button = page.locator('.translation-panel').getByRole('button', { name: '播放发音' });
  async function text(value, index, direction = 'zh-en') {
    await desktop.evaluate((_, data) => { globalThis.__streamTest.text = data.value; globalThis.__streamTest.direction = data.direction; }, { value, direction });
    await input.fill(`这是需要翻译的第${index}段测试文字。`);
    await page.getByTestId('translation-result').filter({ hasText: value }).waitFor();
  }
  async function emit(sequence, pending = 0, overrides = {}) {
    await desktop.evaluate((_, { sequence, pending, overrides }) => {
      const state = globalThis.__streamTest;
      state.pending[pending].onEvent({ ...state.chunk, pcm: state.parts[sequence] || state.chunk.pcm, ...overrides, sequence });
    }, { sequence, pending, overrides });
  }
  async function complete(pending = 0) {
    await desktop.evaluate((_, index) => {
      const state = globalThis.__streamTest;
      state.completed++;
      state.pending[index].resolve({ audio: state.wav, engine: 'kokoro', streamed: true });
    }, pending);
  }
  const timeout = real ? 90000 : process.platform === 'darwin' && process.env.CI ? 45000 : 30000;
  if (!real) {
    await text('This long paragraph is generated one piece at a time. The first piece should play while the remaining pieces are still being generated.', 1);
    await button.click();
    await page.waitForFunction(() => window.__streamPlayback.clicks.length === 1);
    await emit(0);
    await page.waitForFunction(() => window.__streamPlayback.starts.length === 1);
    assert.equal(await desktop.evaluate(() => globalThis.__streamTest.completed), 0, 'Playback starts before the complete WAV exists');
    assert.equal((await page.evaluate(() => window.bestdict.getSpeechCache())).count, 0, 'Partial audio is not cached');
    await emit(1); await emit(2); await complete();
    await button.waitFor({ timeout });
    assert.equal((await page.evaluate(() => window.bestdict.getSpeechCache())).count, 1);
    const schedules = await page.evaluate(() => window.__streamPlayback.schedules);
    assert.equal(schedules.length, 3, 'Final response does not replay the whole WAV');
    const markers = [[32767, -32768, 1234, -4567], [12345, -12345, 1, -1], [2468, -2468, 32766, -32767]];
    for (const [index, marker] of markers.entries()) assert.deepEqual(schedules[index].samples, marker.map(value => value / 32768), 'Signed little-endian samples are decoded and scheduled in their original order');
    for (let index = 1; index < schedules.length; index++) assert.ok(Math.abs(schedules[index].when - schedules[index - 1].when - schedules[index - 1].duration) < .001, 'Chunks share a continuous audio clock');
    await button.click();
    await page.waitForFunction(() => window.__streamPlayback.fullPlays === 1);
    assert.equal(await desktop.evaluate(() => globalThis.__streamTest.generations), 1, 'Cached replay skips inference');
    await page.locator('.translation-panel').getByRole('button', { name: '停止发音' }).click();

    await text('Cancel this new paragraph after the first audio segment. Later audio must not be played or cached.', 2);
    await button.click(); await emit(0, 1);
    await page.waitForFunction(() => window.__streamPlayback.schedules.length === 4);
    await page.locator('.translation-panel').getByRole('button', { name: '停止发音' }).click();
    await emit(1, 1); await complete(1);
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.__streamPlayback.schedules.length), 4);
    assert.equal((await page.evaluate(() => window.bestdict.getSpeechCache())).count, 1);

    await text('Simulate slow inference with a short first segment. Buffering should keep the later playback continuous.', 3);
    await button.click(); await emit(0, 2, { generationMs: 1200 });
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.__streamPlayback.schedules.length), 4, 'Slow generation reserves a second segment');
    await emit(1, 2, { generationMs: 1200 }); await emit(2, 2); await complete(2);
    await button.waitFor({ timeout });
    assert.equal(await page.evaluate(() => window.__streamPlayback.schedules.length), 7);

    await text('Changing the query while audio is being generated must discard the current stream.', 4);
    await button.click();
    await input.fill('apple');
    await page.getByTestId('entry-word').filter({ hasText: 'apple' }).waitFor();
    await emit(0, 3); await complete(3);
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.__streamPlayback.schedules.length), 7);

    await text('Clearing the cache during generation should keep playback working and prevent this audio from returning to the cache.', 5);
    await button.click(); await emit(0, 4);
    await page.waitForFunction(() => window.__streamPlayback.schedules.length === 8);
    await page.evaluate(() => window.bestdict.clearSpeechCache());
    await emit(1, 4); await emit(2, 4); await complete(4);
    await button.waitFor({ timeout });
    assert.equal((await page.evaluate(() => window.bestdict.getSpeechCache())).count, 0);

    await text('A generation error after playback begins must stop all scheduled audio and discard the incomplete cache.', 6);
    await button.click(); await emit(0, 5);
    await page.waitForFunction(() => window.__streamPlayback.schedules.length === 11);
    await desktop.evaluate(() => globalThis.__streamTest.pending[5].reject(new Error('测试合成失败。')));
    await page.getByRole('alert').filter({ hasText: '测试合成失败' }).waitFor();
    await button.waitFor();
    await emit(1, 5);
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.__streamPlayback.schedules.length), 11);
    assert.equal((await page.evaluate(() => window.bestdict.getSpeechCache())).count, 0);

    await text('Hiding the window stops the current stream and rejects later audio segments from the same request.', 7);
    await button.click(); await emit(0, 6);
    await page.waitForFunction(() => window.__streamPlayback.schedules.length === 12);
    await page.evaluate(() => window.bestdict.hide());
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    await button.waitFor();
    await emit(1, 6); await complete(6);
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.__streamPlayback.schedules.length), 12);
    report.cases.push({ fixture: true, firstChunkBeforeCompletion: true, gaplessScheduling: true, cachedReplay: true, cancellation: true, queryChange: true, slowBuffering: true, clearingDuringStream: true, midstreamError: true, hiddenCancellation: true });
  } else {
    let cases = long ? [['longEnglishParagraph', ('Please review the report before Friday. We need to confirm the delivery schedule, check the latest figures, and discuss the remaining questions with the team. After everyone has shared their feedback, we can prepare the final proposal and send it to the customer. ').repeat(3).trim(), 'zh-en', 1]] : [
      ['englishParagraph', 'Please review the report before Friday. We need to confirm the delivery schedule, check the latest figures, and discuss the remaining questions with the team. After everyone has shared their feedback, we can prepare the final proposal and send it to the customer.', 'zh-en', 1],
      ['englishLongSentence', 'Before we send the final report to the customer, we need to confirm the delivery schedule with the team, review the latest sales figures and check the supporting documents, collect feedback from everyone involved in the project, and make sure that all remaining questions have been answered clearly.', 'zh-en', 1],
      ['chineseParagraph', '请在周五之前审核这份报告。我们需要确认交付时间，检查最新数据，并和团队讨论尚未解决的问题。收集所有人的反馈之后，再准备最终方案并发送给客户。', 'en-zh', 1],
      ['chineseUnpunctuated', '我们需要先确认项目的交付时间然后检查最新的数据并和团队讨论尚未解决的问题收集所有人的反馈之后再准备最终方案并发送给客户这样可以避免重复修改也能确保每个人都理解接下来的安排', 'en-zh', 1],
      ['chineseGreeting', '你好，欢迎使用词典。这是当前音色和语速的试听。请先确认项目的交付时间，然后检查最新数据，并和团队讨论尚未解决的问题。', 'en-zh', 1],
      ['fastEnglish', 'Please review the report before Friday. We need to confirm the delivery schedule, check the latest figures, and discuss the remaining questions with the team.', 'zh-en', 2],
    ];
    if (selection) {
      cases = cases.filter(item => selection.split(',').includes(item[0]));
      if (!cases.length) throw new Error('Unknown real speech case');
    }
    for (const [index, [name, value, direction, rate]] of cases.entries()) {
      await page.evaluate(async rate => { const settings = await window.bestdict.getSettings(); await window.bestdict.setSettings({ speech: { ...settings.speech, rate } }); }, rate);
      // Exercise actual activation preparation; the model directory is read-only.
      const deadline = performance.now() + 15000;
      while (!(await desktop.evaluate(() => { const { speech } = globalThis.__bestdictNative.getServices(); return speech.prepared?.child === speech.worker.process && !!speech.worker.process; }))) {
        if (performance.now() > deadline) {
          console.log('Preparation evidence', await desktop.evaluate(async () => {
            const { speech } = globalThis.__bestdictNative.getServices();
            try { await speech.prepare(globalThis.__bestdictNative.readSettings().speech); }
            catch (error) { return { error: error.message, config: speech.worker.config, keepAlive: speech.worker.keepAlive }; }
            return { config: speech.worker.config, prepared: !!speech.prepared, pending: speech.worker.pending.size };
          }));
          throw new Error('Model did not prepare');
        }
        await page.waitForTimeout(50);
      }
      await text(value, index + 1, direction);
      const offset = await page.evaluate(() => ({ schedules: window.__streamPlayback.schedules.length, starts: window.__streamPlayback.starts.length }));
      await button.click();
      await page.waitForFunction(offset => window.__streamPlayback.starts.length > offset, offset.starts, { timeout });
      const firstMs = await page.evaluate(offset => window.__streamPlayback.starts[offset] - window.__streamPlayback.clicks.at(-1), offset.starts);
      await button.waitFor({ timeout });
      const schedules = await page.evaluate(offset => window.__streamPlayback.schedules.slice(offset), offset.schedules);
      const gaps = schedules.slice(1).map((item, index) => Math.max(0, item.when - schedules[index].when - schedules[index].duration) * 1000);
      const native = await desktop.evaluate(() => ({ generationMs: globalThis.__streamTest.generationMs, audioDuration: globalThis.__streamTest.audioDuration }));
      assert.ok(schedules.length > 1);
      assert.ok(firstMs < native.generationMs, 'First audio starts before all synthesis finishes');
      assert.ok(Math.max(0, ...gaps) < 20, `${name} extra playback gap: ${gaps}`);
      assert.ok(Math.abs(schedules.reduce((sum, item) => sum + item.duration, 0) - native.audioDuration) < .0001, 'All generated samples play once, in order');
      const entry = { name, rate, firstAudioMs: firstMs, generationMs: native.generationMs, chunks: schedules.length, maxExtraGapMs: Math.max(0, ...gaps), audioDuration: schedules.reduce((sum, item) => sum + item.duration, 0) };
      report.cases.push(entry); console.log(entry);
    }
  }
  assert.deepEqual(errors, []);
  await mkdir('test-results/speech-stream', { recursive: true });
  await writeFile(`test-results/speech-stream/${selection ? 'real-selected' : long ? 'real-long' : real ? 'real' : 'fixture'}.json`, JSON.stringify(report, null, 2));
  console.log('Speech stream UI passed:', report);
} finally { await closeElectronTest(desktop); }
