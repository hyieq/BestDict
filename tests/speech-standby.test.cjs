const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { SpeechService } = require('../electron/speech.cjs');
const { defaultSpeech } = require('../electron/speech-options.cjs');

// Real child process and JSONL transport, using a small local model stand-in.
// No downloads, installed models, user settings, or real audio playback.
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bestdict-standby-test-'));
  const script = path.join(directory, 'speech_worker.py');
  await fs.writeFile(script, `import sys, json, time, base64
loaded = 0
for raw in sys.stdin:
    request = json.loads(raw)
    method = request['method']
    if method == 'prepare':
        time.sleep(.05)
        loaded += 1
        result = {'ready': True}
    else:
        if request['text'] == 'slow':
            time.sleep(30)
        result = {'audio': base64.b64encode(b'RIFF' + bytes(300)).decode(), 'engine': 'kokoro', 'loads': loaded}
    print(json.dumps({'id': request['id'], 'result': result}), flush=True)
`);
  const model = { ready: true };
  const root = path.resolve(__dirname, '..');
  const speech = new SpeechService({
    python: process.env.BESTDICT_PYTHON || path.join(root, 'runtime/python', process.platform === 'win32' ? 'python.exe' : 'bin/python3'),
    backend: directory, resources: { kokoroRoot: () => directory, kokoroStatus: () => model }, standbyTimeout: 100,
  });
  t.after(async () => {
    await speech.stop();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('bestdict-standby-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { speech, model };
}

async function until(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail('Timed out waiting for speech process state');
}

test('activation deduplicates preparation, early playback joins it, and visible idle/playback preserve the model', async t => {
  const { speech } = await fixture(t);
  const first = speech.setActive(true, defaultSpeech);
  const second = speech.setActive(true, defaultSpeech);
  const audio = speech.synthesize('hello', 'en', defaultSpeech);
  const [, , result] = await Promise.all([first, second, audio]);
  assert.equal(result.loads, 1);
  assert.equal(speech.worker.nextId, 2, 'One preparation and one synthesis');
  const child = speech.worker.process;
  await speech.cancel();
  await delay(150);
  assert.equal(speech.worker.process, child, 'Visible model survives beyond the hidden idle deadline');
  assert.equal((await speech.synthesize('another word', 'en', defaultSpeech)).loads, 1);
  assert.equal(speech.worker.process, child);
  await speech.setActive(true, { ...defaultSpeech, rate: 1.5, kokoroVoices: { en: 1, zh: 58 } });
  assert.equal(speech.worker.nextId, 3, 'Changing speed or a voice within the same accent reuses preparation');
});

test('hidden models are released after the grace period, rapid reactivation retains them, and later activation reloads', async t => {
  const { speech } = await fixture(t);
  await speech.setActive(true, defaultSpeech);
  const child = speech.worker.process;
  await speech.setActive(false, defaultSpeech);
  assert.equal(speech.worker.process, child, 'Hiding does not immediately unload the model');
  await speech.setActive(true, defaultSpeech);
  await delay(150);
  assert.equal(speech.worker.process, child);
  await speech.setActive(false, defaultSpeech);
  await until(() => !speech.worker.process);
  await speech.setActive(true, defaultSpeech);
  assert.notEqual(speech.worker.process, child);
  assert.equal((await speech.synthesize('hello', 'en', defaultSpeech)).loads, 1);
});

test('changing accent back during preparation finishes with the latest selected accent ready', async t => {
  const { speech } = await fixture(t);
  await speech.setActive(true, defaultSpeech);
  const british = { ...defaultSpeech, kokoroVoices: { en: 2, zh: 3 } };
  const loadingBritish = speech.setActive(true, british);
  const loadingAmerican = speech.setActive(true, defaultSpeech);
  await Promise.all([loadingBritish, loadingAmerican]);
  assert.equal(speech.prepared.voice, 0);
  assert.equal((await speech.synthesize('hello', 'en', defaultSpeech)).loads, 3, 'No extra preparation on the subsequent click');
});

test('cancelling real inference kills its process and discards audio; the next request can prepare and play', async t => {
  const { speech } = await fixture(t);
  await speech.setActive(true, defaultSpeech);
  const child = speech.worker.process;
  const audio = speech.synthesize('slow', 'en', defaultSpeech);
  const rejected = assert.rejects(audio, /取消|停止/);
  await until(() => [...speech.worker.pending.values()].some(task => task.method === 'synthesize'));
  await speech.cancel();
  await rejected;
  assert.equal(speech.worker.process, null);
  assert.equal((await speech.synthesize('hello', 'en', defaultSpeech)).loads, 1);
  assert.notEqual(speech.worker.process, child);
});

test('missing models and system-only settings never prepare; system switch, model replacement and quit unload immediately', async t => {
  const { speech, model } = await fixture(t);
  model.ready = false;
  await speech.setActive(true, defaultSpeech);
  assert.equal(speech.worker.process, null);
  model.ready = true;
  const system = { ...defaultSpeech, engine: 'system' };
  await speech.setActive(true, system);
  assert.equal(speech.worker.process, null);
  await speech.setActive(true, defaultSpeech);
  await speech.setActive(true, system);
  assert.equal(speech.worker.process, null);
  await speech.setActive(true, defaultSpeech);
  await speech.suspend();
  await speech.setActive(true, defaultSpeech);
  assert.equal(speech.worker.process, null);
  speech.suspended = false;
  await speech.setActive(true, defaultSpeech);
  await speech.stop();
  assert.equal(speech.worker.process, null);
  assert.equal(speech.worker.keepAlive, false);
});

test('cancelling a click while preparation is running discards that click but preserves background readiness', async t => {
  const { speech } = await fixture(t);
  const preparation = speech.setActive(true, defaultSpeech);
  const audio = speech.synthesize('hello', 'en', defaultSpeech);
  const rejected = assert.rejects(audio, /停止/);
  await until(() => [...speech.worker.pending.values()].some(task => task.method === 'prepare'));
  const child = speech.worker.process;
  await speech.cancel();
  await preparation;
  await rejected;
  assert.equal(speech.worker.process, child);
  assert.equal((await speech.synthesize('next word', 'en', defaultSpeech)).loads, 1);
});

test('failure to prepare is retryable and unloading during startup cannot resurrect the process', async t => {
  const { speech } = await fixture(t);
  const script = speech.worker.config.script;
  speech.worker.config.script = path.join(path.dirname(script), 'missing.py');
  await assert.rejects(speech.setActive(true, defaultSpeech), /退出/);
  speech.worker.config.script = script;
  await speech.setActive(true, defaultSpeech);
  await speech.stop();
  const preparation = speech.setActive(true, defaultSpeech);
  const rejected = assert.rejects(preparation, /停止|取消/);
  await speech.stop();
  await rejected;
  await delay(30);
  assert.equal(speech.worker.process, null);
});

test('activating a system-only window does not cancel ongoing system voice discovery or synthesis', async t => {
  const { speech } = await fixture(t);
  let discover;
  speech.voices = () => new Promise(resolve => { discover = resolve; });
  speech.windows = async () => 'system audio';
  const options = { ...defaultSpeech, engine: 'system' };
  const audio = speech.synthesize('hello', 'en', options);
  await until(() => !!discover);
  await speech.setActive(true, options);
  discover([{ id: 'fixture', language: 'en-US' }]);
  assert.equal((await audio).audio, 'system audio');
});
