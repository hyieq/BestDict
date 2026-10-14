// Diagnose real Kokoro latency without changing the installed client, model, or cache.
// Requires an existing model; never downloads one. Audio playback is muted.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { closeElectronTest } from './close-electron-test.mjs';

const require = createRequire(import.meta.url);
const { SpeechService } = require('../electron/speech.cjs');
const { defaultSpeech } = require('../electron/speech-options.cjs');
const root = process.cwd();
const model = path.resolve(process.env.BESTDICT_PROFILE_KOKORO || '.cache/speech-validation/kokoro/model');
await readFile(path.join(model, 'model.int8.onnx'));
const output = path.resolve('test-results/speech-latency');
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(path.join(os.tmpdir(), 'bestdict-speech-profile-'));
const source = await readFile(path.join(root, 'backend/speech_worker.py'), 'utf8');
let profiled = source;
const script = path.join(temporary, 'speech_worker.py');
await writeFile(script, profiled);
await writeFile(path.join(temporary, 'speech_segments.py'), await readFile(path.join(root, 'backend/speech_segments.py')));
const python = process.env.BESTDICT_PYTHON || path.join(root, 'runtime/python', process.platform === 'win32' ? 'python.exe' : 'bin/python3');
const report = { date: new Date().toISOString(), platform: process.platform, cpu: os.cpus()[0]?.model,
  appVersion: JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version,
  threads: Math.min(4, os.cpus().length), workerSha256: createHash('sha256').update(source).digest('hex'),
  service: [], modelPreparations: [], persistentWorker: [], standby: [], threadSweep: [], ui: [] };
function audioInfo(base64) {
  const wav = Buffer.from(base64, 'base64');
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  const rate = wav.readUInt32LE(24);
  let onset = 0;
  for (let index = 44; index < wav.length; index += 2) {
    if (Math.abs(wav.readInt16LE(index)) >= 100) { onset = (index - 44) / 2 / rate * 1000; break; }
  }
  return { durationMs: (wav.length - 44) / 2 / rate * 1000, firstNonSilentMs: onset };
}
function row(label, result, totalMs, pid) {
  return { label, totalMs: Math.round(totalMs), pid, cached: result.cached ?? false,
    ...result.profile, ...audioInfo(result.audio) };
}
const service = new SpeechService({ python, backend: path.join(root, 'backend'),
  resources: { kokoroRoot: () => model, kokoroStatus: () => ({ ready: true, sha256: 'profile-model' }) },
  cacheDirectory: path.join(temporary, 'cache') });
service.worker.config.script = script;
const workerRequest = service.worker.request.bind(service.worker);
service.worker.request = async (...args) => {
  const started = performance.now();
  const result = await workerRequest(args[0], { ...args[1], _profile: true }, args[2]);
  if (args[0] === 'prepare') report.modelPreparations.push({ voice: args[1].voice, totalMs: performance.now() - started, ...result.profile });
  return result;
};
let desktop;
try {
  for (const text of ['apple', 'banana', 'dictionary', 'apple']) {
    const start = performance.now();
    const result = await service.synthesize(text, 'en', defaultSpeech);
    const entry = row(text, result, performance.now() - start, service.worker.process?.pid ?? null);
    report.service.push(entry);
    console.log('Service', entry);
  }
  await service.stop();
  for (const threads of [1, 2, 8]) {
    const threadedScript = path.join(temporary, `speech_worker_${threads}.py`);
    assert.ok(profiled.includes('num_threads=min(4, os.cpu_count() or 2)'));
    await writeFile(threadedScript, profiled.replace('num_threads=min(4, os.cpu_count() or 2)', `num_threads=${threads}`));
    service.worker.config.script = threadedScript;
    for (const text of ['apple', 'banana', 'dictionary']) {
      const start = performance.now();
      const result = await service.worker.request('synthesize', { text, language: 'en', voice: 0, rate: 1 });
      const entry = { threads, ...row(text, result, performance.now() - start, service.worker.process?.pid) };
      report.threadSweep.push(entry);
      console.log('Threads', entry);
    }
    await service.stop();
  }
  service.worker.config.script = script;
  for (const text of ['apple', 'banana', 'dictionary', 'hello', '你好']) {
    const start = performance.now();
    const result = await service.worker.request('synthesize', { text, language: text === '你好' ? 'zh' : 'en', voice: text === '你好' ? 3 : 0, rate: 1 });
    const entry = row(text, result, performance.now() - start, service.worker.process?.pid);
    report.persistentWorker.push(entry);
    console.log('Persistent worker', entry);
  }
  await service.stop();
  const preparationStart = performance.now();
  await service.setActive(true, defaultSpeech);
  report.preparationMs = performance.now() - preparationStart;
  await service.clearCache();
  for (const text of ['apple', 'banana', 'dictionary']) {
    const start = performance.now();
    const result = await service.synthesize(text, 'en', defaultSpeech);
    const entry = row(text, result, performance.now() - start, service.worker.process?.pid);
    report.standby.push(entry);
    console.log('Standby', entry);
  }
  await service.stop();
  const env = { ...process.env, BESTDICT_TEST: '1', BESTDICT_TEST_SHORTCUT: 'Control+Alt+Shift+F12' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.BESTDICT_LIBRARY;
  const executablePath = process.env.BESTDICT_TEST_EXE;
  desktop = await electron.launch({ args: executablePath ? [] : ['.'], executablePath, cwd: root, env });
  const page = await desktop.firstWindow();
  await page.getByText('离线资源已就绪').waitFor();
  await desktop.evaluate(async (_, { model, script, python, cacheDirectory }) => {
    const { resources, speech } = globalThis.__bestdictNative.getServices();
    await speech.stop();
    resources.kokoroStatus = () => ({ ready: true, sha256: 'profile-model' });
    speech.worker.config = { ...speech.worker.config, python, script, assets: model };
    speech.cache.directory = cacheDirectory;
    globalThis.__speechProfile = { calls: [], stops: [], preparations: [] };
    const request = speech.worker.request.bind(speech.worker);
    speech.worker.request = async (...args) => {
      const start = performance.now();
      const result = await request(args[0], { ...args[1], _profile: true }, args[2]);
      if (args[0] === 'prepare') globalThis.__speechProfile.preparations.push({ totalMs: performance.now() - start, profile: result.profile });
      return result;
    };
    const synthesize = speech.synthesize.bind(speech);
    speech.synthesize = async (...args) => {
      const start = performance.now();
      const result = await synthesize(...args);
      globalThis.__speechProfile.calls.push({ text: args[0], totalMs: performance.now() - start,
        pid: speech.worker.process?.pid ?? null, cached: result.cached, profile: result.profile });
      return result;
    };
    const stop = speech.worker.stop.bind(speech.worker);
    speech.worker.stop = (...args) => {
      globalThis.__speechProfile.stops.push({ pid: speech.worker.process?.pid ?? null, pending: speech.worker.pending.size });
      return stop(...args);
    };
  }, { model, script, python, cacheDirectory: path.join(temporary, 'ui-cache') });
  await page.evaluate(async () => {
    const settings = await window.bestdict.getSettings();
    await window.bestdict.setSettings({ speech: { ...settings.speech, engine: 'kokoro' } });
  });
  await page.reload();
  await page.getByText('离线资源已就绪').waitFor();
  // Allow background activation preparation to complete; do not initiate it from the test.
  const preparationDeadline = performance.now() + 15000;
  while (!(await desktop.evaluate(() => globalThis.__speechProfile.preparations.length))) {
    if (performance.now() > preparationDeadline) throw new Error('Activation did not prepare Kokoro');
    await page.waitForTimeout(50);
  }
  await page.evaluate(() => {
    window.__speechProfile = { clips: [] };
    document.addEventListener('click', event => {
      if (event.target.closest('.entry-word-row button[aria-label="播放发音"]')) {
        window.__speechProfile.current = { click: performance.now() };
        window.__speechProfile.clips.push(window.__speechProfile.current);
      }
    }, true);
    const decode = window.atob;
    window.atob = (...args) => {
      window.__speechProfile.current.response = performance.now();
      return decode.apply(window, args);
    };
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      const current = window.__speechProfile.current;
      this.muted = true;
      current.playCall = performance.now();
      this.addEventListener('playing', () => { current.playing = performance.now(); }, { once: true });
      this.addEventListener('ended', () => { current.ended = performance.now(); }, { once: true });
      return play.call(this);
    };
  });
  const input = page.getByRole('textbox', { name: '输入单词或句子' });
  for (const [index, text] of ['apple', 'banana', 'dictionary', 'apple'].entries()) {
    await input.fill(text);
    await page.getByTestId('entry-word').filter({ hasText: text }).waitFor();
    const button = page.locator('.entry-word-row').getByRole('button', { name: '播放发音' });
    await button.click();
    try {
      await page.waitForFunction(index => window.__speechProfile.clips[index]?.ended, index, { timeout: 15000 });
    } catch (error) {
      console.log('Renderer evidence', await page.evaluate(() => ({ profile: window.__speechProfile, text: document.body.innerText })));
      console.log('Service evidence', await desktop.evaluate(() => globalThis.__speechProfile));
      throw error;
    }
    await button.waitFor();
    const entry = await page.evaluate(index => {
      const clip = window.__speechProfile.clips[index];
      return { clickToPlayingMs: clip.playing - clip.click, clickToResponseMs: clip.response - clip.click,
        responseToPlayMs: clip.playCall - clip.response, playerStartMs: clip.playing - clip.playCall };
    }, index);
    report.ui.push({ text, ...entry });
    console.log('UI', text, entry);
  }
  report.uiService = await desktop.evaluate(() => globalThis.__speechProfile);
  const preparedPid = await desktop.evaluate(() => {
    const { speech } = globalThis.__bestdictNative.getServices();
    speech.worker.idleTimeout = 500; // Shorten only this isolated test's hidden grace period.
    return speech.worker.process.pid;
  });
  await page.evaluate(() => window.bestdict.hide());
  assert.equal(await desktop.evaluate(() => globalThis.__bestdictNative.getServices().speech.worker.keepAlive), false);
  assert.equal(await desktop.evaluate(() => globalThis.__bestdictNative.getServices().speech.worker.process?.pid), preparedPid);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  await page.waitForTimeout(600);
  assert.equal(await desktop.evaluate(() => globalThis.__bestdictNative.getServices().speech.worker.process?.pid), preparedPid);
  await page.evaluate(() => window.bestdict.hide());
  const releaseDeadline = performance.now() + 15000;
  while (await desktop.evaluate(() => !!globalThis.__bestdictNative.getServices().speech.worker.process)) {
    if (performance.now() > releaseDeadline) throw new Error('Hidden Kokoro process was not released');
    await page.waitForTimeout(50);
  }
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  const restoreDeadline = performance.now() + 15000;
  while (!(await desktop.evaluate(() => {
    const { speech } = globalThis.__bestdictNative.getServices();
    return !!speech.prepared && speech.prepared.child === speech.worker.process;
  }))) {
    if (performance.now() > restoreDeadline) throw new Error('Restoring the window did not prepare Kokoro again');
    await page.waitForTimeout(50);
  }
  const restoredPid = await desktop.evaluate(() => globalThis.__bestdictNative.getServices().speech.worker.process.pid);
  assert.notEqual(restoredPid, preparedPid);
  report.windowLifecycle = { preparedPid, restoredPid, rapidRestoreRetained: true, hiddenReleased: true, restorePrepared: true };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Saved ${path.join(output, 'report.json')}`);
} finally {
  if (desktop) await closeElectronTest(desktop);
  await service.stop();
  assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith('bestdict-speech-profile-'));
  await rm(temporary, { recursive: true, force: true });
}
