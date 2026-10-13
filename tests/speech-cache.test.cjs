const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { SpeechCache } = require('../electron/speech-cache.cjs');
const { SpeechService } = require('../electron/speech.cjs');
const { defaultSpeech } = require('../electron/speech-options.cjs');

function wav() {
  const audio = Buffer.alloc(300);
  audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(16000, 24); audio.writeUInt32LE(32000, 28); audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(audio.length - 44, 40);
  return audio.toString('base64');
}
async function folder(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bestdict-speech-cache-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('bestdict-speech-cache-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}
function service(directory, model = { ready: true, sha256: 'model-one' }) {
  const speech = new SpeechService({ python: 'unused', backend: __dirname, platform: 'win32', cacheDirectory: directory,
    resources: { kokoroRoot: () => __dirname, kokoroStatus: () => model } });
  speech.worker.request = async () => ({ audio: wav(), engine: 'kokoro' });
  return speech;
}

test('replays and process restarts reuse Kokoro audio without invoking synthesis', async t => {
  const directory = await folder(t);
  const speech = service(directory);
  t.after(() => speech.stop());
  let requests = 0;
  speech.worker.request = async () => { requests++; return { audio: wav(), engine: 'kokoro' }; };
  assert.equal((await speech.synthesize('hello', 'en', defaultSpeech)).cached, false);
  assert.equal((await speech.synthesize('hello', 'en', { ...defaultSpeech, engine: 'kokoro' })).cached, true);
  assert.equal(requests, 1, 'Auto and explicit Kokoro use the same resolved voice');
  const restarted = service(directory);
  t.after(() => restarted.stop());
  restarted.worker.request = () => { throw new Error('Cache hit must not start inference'); };
  assert.equal((await restarted.synthesize('hello', 'en', defaultSpeech)).audio, wav());
  assert.equal((await restarted.cacheStatus()).count, 1);
  const files = await fs.readdir(directory);
  assert.ok(files.every(file => /^[a-f0-9]{64}\.wav$/.test(file)), 'File names contain no query text');
});

test('text, language, voice, speed, model and resolved engine separate cached audio', async t => {
  const model = { ready: true, sha256: 'model-one' };
  const speech = service(await folder(t), model);
  t.after(() => speech.stop());
  let requests = 0;
  speech.worker.request = async () => { requests++; return { audio: wav(), engine: 'kokoro' }; };
  await speech.synthesize('hello', 'en', defaultSpeech);
  await speech.synthesize('Hello', 'en', defaultSpeech);
  await speech.synthesize('hello', 'zh', defaultSpeech);
  await speech.synthesize('hello', 'en', { ...defaultSpeech, rate: 1.3 });
  await speech.synthesize('hello', 'en', { ...defaultSpeech, kokoroVoices: { en: 1, zh: 3 } });
  model.sha256 = 'model-two';
  await speech.synthesize('hello', 'en', defaultSpeech);
  assert.equal(requests, 6);
  speech.voices = async () => [{ id: 'system-one', language: 'en-US' }, { id: 'system-two', language: 'en-GB' }];
  let systemRequests = 0;
  speech.windows = async () => { systemRequests++; return wav(); };
  const preferences = { ...defaultSpeech, engine: 'system' };
  assert.equal((await speech.synthesize('hello', 'en', preferences)).cached, false);
  assert.equal((await speech.synthesize('hello', 'en', preferences)).cached, true);
  await speech.synthesize('hello', 'en', { ...preferences, systemVoices: { en: 'system-two' } });
  assert.equal(systemRequests, 2);
});

test('byte and entry limits evict least recently used audio, including after restart', async t => {
  const directory = await folder(t);
  const cache = new SpeechCache(directory, { maxBytes: 600, maxEntries: 10 });
  const [a, b, c] = ['a', 'b', 'c'].map(text => cache.key({ text }));
  await cache.put(a, wav()); await cache.put(b, wav());
  assert.ok(await cache.get(a));
  await cache.put(c, wav());
  assert.equal(await cache.get(b), null);
  assert.ok(await cache.get(a)); assert.ok(await cache.get(c));
  assert.equal((await cache.status()).bytes, 600);
  const restarted = new SpeechCache(directory, { maxBytes: 10000, maxEntries: 1 });
  assert.equal((await restarted.status()).count, 1);
  assert.equal(await restarted.get(a), null);
  assert.ok(await restarted.get(c));
  await restarted.put(a, Buffer.alloc(10001).toString('base64'));
  assert.equal((await restarted.status()).count, 1, 'Oversized/invalid audio is not retained');
});

test('corrupt cached audio is discarded and regenerated; storage failures do not block speech', async t => {
  const directory = await folder(t);
  const speech = service(directory);
  t.after(() => speech.stop());
  await speech.synthesize('hello', 'en', defaultSpeech);
  const [file] = await fs.readdir(directory);
  await fs.writeFile(path.join(directory, file), Buffer.alloc(100));
  const result = await speech.synthesize('hello', 'en', defaultSpeech);
  assert.equal(result.cached, false);
  assert.equal(result.audio, wav());
  await fs.writeFile(path.join(directory, file), Buffer.from(wav(), 'base64').subarray(0, -1));
  assert.equal((await speech.synthesize('hello', 'en', defaultSpeech)).cached, false, 'A truncated WAV with intact headers is regenerated');
  const blocked = path.join(directory, 'not-a-directory');
  await fs.writeFile(blocked, 'keep');
  const unavailable = service(blocked);
  t.after(() => unavailable.stop());
  assert.equal((await unavailable.synthesize('hello', 'en', defaultSpeech)).audio, wav());
});

test('clearing removes only generated audio and prevents in-flight synthesis repopulating it', async t => {
  const directory = await folder(t);
  const speech = service(directory);
  t.after(() => speech.stop());
  await speech.synthesize('old audio', 'en', defaultSpeech);
  const modelFile = path.join(directory, 'model.onnx');
  await fs.writeFile(modelFile, 'model stays');
  let resolve, started;
  const began = new Promise(r => { started = r; });
  speech.worker.request = () => { started(); return new Promise(r => { resolve = r; }); };
  const pending = speech.synthesize('new audio', 'en', defaultSpeech);
  await began;
  assert.equal((await speech.clearCache()).count, 0);
  resolve({ audio: wav(), engine: 'kokoro' });
  assert.equal((await pending).audio, wav(), 'Clearing does not prevent current playback');
  assert.equal((await speech.cacheStatus()).count, 0);
  assert.equal(await fs.readFile(modelFile, 'utf8'), 'model stays');
  speech.worker.request = async () => ({ audio: wav(), engine: 'kokoro' });
  assert.equal((await speech.synthesize('new audio', 'en', defaultSpeech)).cached, false);
  assert.equal((await speech.cacheStatus()).count, 1);
});

test('cancelled synthesis does not save audio and queued writes cannot undo a clear', async t => {
  const speech = service(await folder(t));
  t.after(() => speech.stop());
  let resolve, started;
  const began = new Promise(r => { started = r; });
  speech.worker.request = () => { started(); return new Promise(r => { resolve = r; }); };
  const pending = speech.synthesize('cancel me', 'en', defaultSpeech);
  const rejected = assert.rejects(pending, /停止/);
  await began;
  await speech.cancel();
  resolve({ audio: wav(), engine: 'kokoro' });
  await rejected;
  assert.equal((await speech.cacheStatus()).count, 0);
  const generation = speech.cache.generation;
  const writes = Array.from({ length: 5 }, (_, i) => speech.cache.put(speech.cache.key({ text: String(i) }), wav(), generation));
  const clear = speech.clearCache();
  await Promise.all([...writes, clear]);
  assert.equal((await speech.cacheStatus()).count, 0);
});
