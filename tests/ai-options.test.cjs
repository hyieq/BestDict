const { test } = require('node:test');
const assert = require('node:assert/strict');
const { defaultStyles, validateStyles, buildPrompt, translationOptions } = require('../electron/ai-options.cjs');
const { HyTranslator } = require('../electron/hy.cjs');

test('style presets reject malformed, duplicate and oversized settings', () => {
  assert.deepEqual(validateStyles(defaultStyles), defaultStyles);
  for (const value of [[], [defaultStyles[0], defaultStyles[0]], [{ id: 'x', name: '', prompt: 'hi' }], [{ id: 'x', name: 'x', prompt: 'x'.repeat(1001) }]]) {
    assert.throws(() => validateStyles(value));
  }
  assert.throws(() => translationOptions({ polishPrompt: 42 }));
  assert.throws(() => translationOptions({ previousText: 'x'.repeat(20001) }));
});

test('polishing includes original, previous translation and user instruction', () => {
  const prompt = buildPrompt('source', '英语', { stylePrompt: 'formal', polishPrompt: 'shorter', previousText: 'previous' });
  for (const text of ['英语', 'source', 'formal', 'shorter', 'previous', '不得改变原意']) assert.ok(prompt.includes(text));
  assert.ok(!buildPrompt('source', '英语', { previousText: 'stale-result' }).includes('stale-result'));
});

test('AI cache separates styles, edited prompts, polishing and previous results', async () => {
  const hy = new HyTranslator({ executable: '', modelFile: () => '', isReady: () => true });
  hy.start = async () => {};
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: `result-${++calls}` } }] }) });
  try {
    const translate = options => hy.translate('source', 'en-zh', 'en', options);
    const first = await translate({ stylePrompt: 'formal' });
    assert.equal((await translate({ stylePrompt: 'formal' })).cached, true);
    assert.notEqual((await translate({ stylePrompt: 'casual' })).text, first.text);
    await translate({ stylePrompt: 'formal', polishPrompt: 'shorter', previousText: 'a' });
    await translate({ stylePrompt: 'formal', polishPrompt: 'shorter', previousText: 'b' });
    assert.equal(calls, 6);
    assert.equal((await translate({ stylePrompt: 'formal', forceRefresh: true })).cached, false);
    assert.equal(calls, 8);
  } finally { global.fetch = originalFetch; hy.stop(); }
});
