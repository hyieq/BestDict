const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { SpeechService } = require('../electron/speech.cjs');
const { defaultSpeech, validateSpeech, selectSystemVoice } = require('../electron/speech-options.cjs');
const root = path.join(__dirname, '..');
function service(ready = false, platform) {
  return new SpeechService({ python: path.join(root, 'runtime/python/python.exe'), backend: path.join(root, 'backend'),
    resources: { kokoroRoot: () => path.join(root, '.cache/speech-validation/kokoro/model'), kokoroStatus: () => ({ ready }) }, platform });
}
test('speech settings reject corrupt preferences and never select an unrelated language', () => {
  assert.deepEqual(validateSpeech(defaultSpeech), defaultSpeech);
  for (const rate of [NaN, Infinity, 0, 4, '1']) assert.throws(() => validateSpeech({ ...defaultSpeech, rate }));
  assert.throws(() => validateSpeech({ ...defaultSpeech, kokoroVoices: { en: 58, zh: 3 } }));
  const voices = [{ id: 'zh', language: 'zh-CN' }, { id: 'us', language: 'en-US' }, { id: 'gb', language: 'en-GB' }];
  assert.equal(selectSystemVoice(voices, 'en', 'gb').id, 'gb');
  assert.equal(selectSystemVoice(voices, 'en', 'removed').id, 'us');
  assert.throws(() => selectSystemVoice(voices, 'ja', 'us'), /系统未安装/);
});
test('a cancelled synthesis cannot continue after asynchronous voice discovery', async () => {
  const s = service();
  let resolve;
  s.voices = () => new Promise(r => { resolve = r; });
  const task = s.synthesize('hello', 'en', defaultSpeech);
  const rejection = assert.rejects(task, /停止/);
  await new Promise(r => setImmediate(r));
  await s.cancel();
  resolve([{ id: 'test', language: 'en-US' }]);
  await rejection;
  s.stop();
});
test('automatic routing uses Kokoro for Chinese/English and system speech for other languages', async () => {
  const s = service(true);
  const requests = [];
  s.worker.request = async (method, options) => { requests.push(options); return { audio: 'test', engine: 'kokoro' }; };
  assert.equal((await s.synthesize('你好', 'zh', defaultSpeech)).engine, 'kokoro');
  assert.equal(requests[0].voice, 3);
  s.voices = async () => [];
  await assert.rejects(s.synthesize('bonjour', 'fr', defaultSpeech), /系统未安装/);
  await assert.rejects(service().synthesize('hello', 'en', { ...defaultSpeech, engine: 'kokoro' }), /请先/);
  s.stop();
});
test('Windows system speech produces a nonempty RIFF/WAVE without playing aloud', { skip: process.platform !== 'win32' }, async () => {
  const s = service();
  try {
    const voices = await s.voices();
    assert.ok(voices.some(v => v.language === 'en-US'));
    for (const [language, text] of [['en', 'BestDict pronunciation test.'], ['zh', '这是词典发音测试。']]) {
      if (!voices.some(v => v.language.split('-')[0] === language)) continue;
      const audio = Buffer.from((await s.synthesize(text, language, defaultSpeech)).audio, 'base64');
      assert.equal(audio.toString('ascii', 0, 4), 'RIFF');
      assert.equal(audio.toString('ascii', 8, 12), 'WAVE');
      assert.ok(audio.length > 5000);
    }
  } finally { s.stop(); }
});
test('macOS voice discovery preserves multiword names and uses WAV output arguments', async () => {
  const s = service(false, 'darwin');
  const calls = [];
  s.run = async (command, args, input) => {
    calls.push({ command, args, input });
    if (args[0] === '-v' && args[1] === '?') return 'Samantha (English) en_US # Hello\nTingting zh_CN # 你好';
    fs.writeFileSync(args[args.indexOf('-o') + 1], 'RIFFtestWAVE');
    return '';
  };
  const result = await s.synthesize('Hello; $(literal)', 'en', defaultSpeech);
  assert.equal(Buffer.from(result.audio, 'base64').toString(), 'RIFFtestWAVE');
  assert.ok(calls[1].args.includes('Samantha (English)'));
  assert.ok(calls[1].args.includes('--data-format=LEI16@22050'));
  assert.equal(calls[1].input, 'Hello; $(literal)');
  s.stop();
});

test('real Kokoro model produces English/Chinese audio and responds to speed', { skip: process.env.BESTDICT_TEST_KOKORO !== '1' }, async () => {
  const s = service(true);
  try {
    const samples = [];
    for (const [language, text, rate] of [['en', 'The future is full of possibilities.', 1], ['en', 'The future is full of possibilities.', 1.5], ['zh', '你好，这是离线发音测试。', 1]]) {
      const result = await s.synthesize(text, language, { ...defaultSpeech, rate });
      const audio = Buffer.from(result.audio, 'base64');
      assert.equal(result.engine, 'kokoro');
      assert.equal(audio.toString('ascii', 0, 4), 'RIFF');
      assert.ok(audio.length > 5000);
      assert.ok(audio.subarray(44).some(byte => byte !== 0));
      samples.push(audio.length);
    }
    assert.ok(samples[1] < samples[0] * .9, 'Faster voice produces shorter audio');
  } finally { s.stop(); }
});
