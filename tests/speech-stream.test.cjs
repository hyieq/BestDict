const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const { SpeechService } = require('../electron/speech.cjs');
const { defaultSpeech } = require('../electron/speech-options.cjs');
const { streamSpeech, SpeechSessions } = require('../electron/speech-stream.cjs');
const { WorkerClient } = require('../electron/worker.cjs');
const root = path.resolve(__dirname, '..');

test('speech segmentation preserves text, pronunciation tokens and bounded first clauses', () => {
  const python = process.env.BESTDICT_PYTHON || path.join(root, 'runtime/python', process.platform === 'win32' ? 'python.exe' : 'bin/python3');
  const result = spawnSync(python, ['-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_speech_segments.py'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('the bundled speech worker imports its segmentation helper without loading a model', async () => {
  const python = process.env.BESTDICT_PYTHON || path.join(root, 'runtime/python', process.platform === 'win32' ? 'python.exe' : 'bin/python3');
  const worker = new WorkerClient(python, path.join(root, 'backend/speech_worker.py'), path.join(root, 'resources'), 'speech');
  try { await assert.rejects(worker.request('prepare', { voice: 99 }), /发音设置无效/); }
  finally { await worker.stop(); }
});

test('active audio chunks refresh the stall deadline while a genuinely stalled stream times out', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bestdict-stream-worker-'));
  const script = path.join(directory, 'worker.py');
  await fs.writeFile(script, `import json, sys, time
for raw in sys.stdin:
    request = json.loads(raw)
    if request['method'] == 'ready':
        print(json.dumps({'id': request['id'], 'result': {'ready': True}}), flush=True)
        continue
    if request['method'] == 'stall':
        time.sleep(30)
    for sequence in range(4):
        time.sleep(.1)
        print(json.dumps({'id': request['id'], 'event': 'audio', 'data': {'sequence': sequence}}), flush=True)
    print(json.dumps({'id': request['id'], 'result': {'complete': True}}), flush=True)
`);
  const python = process.env.BESTDICT_PYTHON || path.join(root, 'runtime/python', process.platform === 'win32' ? 'python.exe' : 'bin/python3');
  const worker = new WorkerClient(python, script, directory, 'speech');
  t.after(async () => {
    await worker.stop();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('bestdict-stream-worker-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const chunks = [];
  // Measure streaming progress separately from Python startup on a busy runner.
  assert.deepEqual(await worker.request('ready', {}, { timeout: 10000 }), { ready: true });
  assert.deepEqual(await worker.request('synthesize', {}, { timeout: 250, onEvent: data => chunks.push(data.sequence) }), { complete: true });
  assert.deepEqual(chunks, [0, 1, 2, 3]);
  await assert.rejects(worker.request('stall', {}, { timeout: 80, onEvent: () => {} }), /超时/);
});

test('stream IPC validates IDs, isolates recipients, preserves cached WAV and does not resend streamed audio', async () => {
  const sent = [];
  const sender = { isDestroyed: () => false, send: (...args) => sent.push(args) };
  const result = await streamSpeech(async ({ onChunk }) => {
    onChunk({ sequence: 0, pcm: 'test', sampleRate: 24000, generationMs: 100 });
    return { audio: 'complete-audio', engine: 'kokoro', cached: false, streamed: true };
  }, sender, 'one-request');
  assert.deepEqual(result, { engine: 'kokoro', cached: false, streamed: true });
  assert.equal(sent[0][0], 'speech:chunk');
  assert.equal(sent[0][1].requestId, 'one-request');
  const cached = { audio: 'cached', engine: 'kokoro', cached: true };
  assert.equal(await streamSpeech(async () => cached, sender, 'cache-hit'), cached);
  assert.equal(await streamSpeech(async () => cached, sender), cached);
  await assert.rejects(streamSpeech(() => assert.fail('Invalid request must not synthesize'), sender, '<bad>'), /无效/);
  sender.isDestroyed = () => true;
  await streamSpeech(async ({ onChunk }) => { onChunk({}); return cached; }, sender, 'closed-window');
  assert.equal(sent.length, 1);
});

test('a late stop from another window cannot cancel its replacement playback', async () => {
  let cancels = 0;
  const notifications = [];
  const sessions = new SpeechSessions({ cancel: async () => { cancels++; }, notify: sender => notifications.push(sender) });
  const sender = { isDestroyed: () => false, send: () => {} };
  const second = { ...sender };
  const produce = async () => ({ audio: 'fixture', engine: 'kokoro' });
  await sessions.start(sender, 'old-request', produce);
  await sessions.start(second, 'new-request', produce);
  await sessions.cancel('old-request');
  await sessions.cancel(undefined, sender);
  await sessions.cancel('new-request', sender);
  assert.equal(cancels, 0);
  assert.equal(sessions.current.sender, second);
  await sessions.cancel('new-request');
  assert.equal(cancels, 1);
  assert.equal(sessions.current, null);
  assert.deepEqual(notifications, [sender, second]);
});

test('chunks arrive before completion, cancel discards late chunks, and another request can run', async () => {
  const speech = new SpeechService({ python: 'unused', backend: __dirname,
    resources: { kokoroRoot: () => __dirname, kokoroStatus: () => ({ ready: true }) } });
  speech.prepare = async () => {};
  let emit, complete;
  speech.worker.request = (_method, _params, options) => {
    emit = options.onEvent;
    return new Promise(resolve => { complete = resolve; });
  };
  const chunks = [];
  const result = speech.synthesize('A long sentence to stream.', 'en', defaultSpeech, { onChunk: chunk => chunks.push(chunk) });
  const rejected = assert.rejects(result, /停止/);
  await new Promise(resolve => setImmediate(resolve));
  emit({ sequence: 0 });
  assert.equal(chunks.length, 1, 'First chunk is observable while synthesis is still pending');
  await speech.cancel();
  emit({ sequence: 1 });
  complete({ audio: 'not cached', engine: 'kokoro', streamed: true });
  await rejected;
  assert.equal(chunks.length, 1);
  speech.worker.request = async () => ({ audio: 'new audio', engine: 'kokoro' });
  assert.equal((await speech.synthesize('next', 'en', defaultSpeech)).audio, 'new audio');
  await speech.stop();
});
