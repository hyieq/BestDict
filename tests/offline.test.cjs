const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { WorkerClient } = require('../electron/worker.cjs');
const root = path.join(__dirname, '..');
const python = process.env.BESTDICT_PYTHON || path.join(root, process.platform === 'win32' ? 'runtime/python/python.exe' : 'runtime/python/bin/python3');
const make = kind => new WorkerClient(python, path.join(root, 'backend/worker.py'), path.join(root,
  kind === 'translation' ? '.cache/validation-library/argos' : 'resources'), kind);
const realModels = process.env.BESTDICT_REAL_ASSETS === '1';
const dict = make('dictionary');
const translator = make('translation');
after(() => { dict.stop(); translator.stop(); });

test('real ECDICT data, exact match, case normalization, prefix suggestions and Chinese lookup', async () => {
  const status = await dict.request('status');
  assert.ok(status.count > 700000);
  const apple = await dict.request('lookup', { text: ' APPLE ' });
  assert.equal(apple.entries[0].word.toLowerCase(), 'apple');
  assert.match(apple.entries[0].translation, /苹果/);
  assert.equal(apple.exact, true);
  const prefix = await dict.request('lookup', { text: 'ser' });
  assert.ok(prefix.entries.length >= 5);
  assert.ok(prefix.entries.every(e => e.word.toLowerCase().startsWith('ser')));
  const chinese = await dict.request('lookup', { text: '苹果' });
  assert.ok(chinese.entries.some(e => e.word.toLowerCase() === 'apple'));
  const absent = await dict.request('lookup', { text: 'zzzzqqqqxxxx' });
  assert.equal(absent.entries.length, 0);
  console.log(`Validated ${status.count.toLocaleString()} offline entries.`);
});

test('real CPU inference translates both directions without tokenizer artifacts and preserves paragraph breaks', { skip: !realModels }, async () => {
  const forward = await translator.request('translate', { text: 'Please send me the report before Friday.', direction: 'en-zh' });
  assert.match(forward.text, /报告/);
  assert.match(forward.text, /周五|星期五/);
  assert.ok(!forward.text.includes('▁'));
  const backward = await translator.request('translate', { text: '今天天气很好，我们一起去公园散步吧。', direction: 'auto' });
  assert.equal(backward.direction, 'zh-en');
  assert.match(backward.text.toLowerCase(), /park/);
  assert.ok(!backward.text.includes('▁'));
  const cached = await translator.request('translate', { text: '今天天气很好，我们一起去公园散步吧。', direction: 'auto' });
  assert.equal(cached.cached, true);
  const paragraphs = await translator.request('translate', { text: 'Good morning.\n\nThank you.', direction: 'en-zh' });
  assert.ok(paragraphs.text.includes('\n\n'));
  await assert.rejects(translator.request('translate', { text: 'a'.repeat(5001), direction: 'en-zh' }), /5,000/);
  console.log(JSON.stringify({ forward: forward.text, backward: backward.text }));
});

test('cancellation rejects obsolete inference and a subsequent request restarts the worker', { skip: !realModels }, async () => {
  const pending = translator.request('translate', { text: 'This is a long sentence to translate. '.repeat(50), direction: 'en-zh' });
  const rejected = assert.rejects(pending, /取消/);
  translator.stop();
  await rejected;
  const ready = await translator.request('status');
  assert.equal(ready.ready, true);
});
