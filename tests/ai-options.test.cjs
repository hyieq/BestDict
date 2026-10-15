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
  global.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: `译文-${++calls}` } }] }) });
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


test('a rewrite cannot replace an English translation with Chinese or cache a failed rewrite', async () => {
  const hy = new HyTranslator({ executable: '', modelFile: () => '', isReady: () => true });
  hy.start = async () => {};
  const original = global.fetch, outputs = ['Nothing can stop my longing for freedom.', '没有任何因素能够阻碍我对自由的渴望', 'Nothing can stop my longing for freedom.', 'My yearning for freedom is unstoppable.'];
  let calls = 0;
  global.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: outputs[calls++] } }] }) });
  try {
    const options = { stylePrompt: defaultStyles[1].prompt };
    const result = await hy.translate('没有什么能够阻挡，我对自由的向往', 'auto', 'en', options);
    assert.match(result.text, /freedom/); assert.equal(result.styleApplied, false); assert.match(result.notice, /已保留/);
    assert.equal(hy.cache.size, 0);
    const retry = await hy.translate('没有什么能够阻挡，我对自由的向往', 'zh-en', 'en', options);
    assert.equal(retry.styleApplied, true); assert.equal(retry.cached, false); assert.match(retry.text, /yearning/);
    assert.equal((await hy.translate('没有什么能够阻挡，我对自由的向往', 'auto', 'en', options)).cached, true);
    assert.equal(calls, 4);
  } finally { global.fetch = original; hy.stop(); }
});

test('wrong-language initial output retries once and never enters cache if it remains wrong', async () => {
  const hy = new HyTranslator({ executable: '', modelFile: () => '', isReady: () => true }); hy.start = async () => {};
  const original = global.fetch; let calls = 0;
  global.fetch = async () => ({ ok: true, json: async () => { calls++; return { choices: [{ message: { content: '这仍然是中文。' } }] }; } });
  try {
    await assert.rejects(hy.translate('我对自由的向往', 'zh-en', 'en'), /目标语言/);
    assert.equal(calls, 2); assert.equal(hy.cache.size, 0);
  } finally { global.fetch = original; hy.stop(); }
});

test('polish fallback preserves a valid target-language reference and rejects a wrong-language reference', async () => {
  const hy = new HyTranslator({ executable: '', modelFile: () => '', isReady: () => true }); hy.start = async () => {};
  const original = global.fetch; const outputs = ['这是错误语言。', 'I long for freedom.', 'My longing is for freedom.']; let calls = 0;
  global.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: outputs[calls++] } }] }) });
  try {
    const result = await hy.translate('我对自由的向往', 'zh-en', 'en', { polishPrompt: '正式一些', previousText: 'I long for freedom.' });
    assert.equal(result.text, 'I long for freedom.'); assert.equal(result.styleApplied, false);
    const repaired = await hy.translate('我对自由的向往', 'zh-en', 'en', { polishPrompt: '正式一些', previousText: '这不是英文。' });
    assert.match(repaired.text, /freedom/); assert.equal(calls, 3);
  } finally { global.fetch = original; hy.stop(); }
});

test('target-language guard permits quotations, proper names, numbers and Japanese Han characters', () => {
  const { matchesTargetLanguage, buildRewritePrompt } = require('../electron/ai-options.cjs');
  assert.equal(matchesTargetLanguage('没有任何因素能够阻碍我对自由的渴望', 'en'), false);
  for (const value of ['2026-10-15', 'OpenAI', 'The word “自由” means freedom.', 'Beijing (北京) is the capital of China.']) assert.equal(matchesTargetLanguage(value, 'en'), true);
  assert.equal(matchesTargetLanguage('世界', 'ja'), true);
  assert.equal(matchesTargetLanguage('OpenAI', 'zh'), true);
  const prompt = buildRewritePrompt('我对自由的向往', '英语', 'My longing for freedom.', { stylePrompt: defaultStyles[1].prompt });
  assert.match(prompt, /output language MUST remain English/i); assert.match(prompt, /formal/);
});
