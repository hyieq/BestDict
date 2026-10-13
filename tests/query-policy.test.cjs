const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isSentence, basicDirection } = require('../electron/query-policy.mjs');

test('unknown words and short phrases remain dictionary queries', () => {
  for (const text of ['apple', 'machine learning', 'take care of', 'state of the art', 'U.S.', '恰到好处', 'こんにちは', '사랑']) assert.equal(isSentence(text), false, text);
  for (const text of ['Please send me the report before Friday.', 'I am happy', '今天天气很好，我们一起去公园散步吧。', 'Bonjour, comment allez-vous ?']) assert.equal(isSentence(text), true, text);
});

test('basic translation is independent of the selected dictionary and rejects unsupported languages', () => {
  assert.equal(basicDirection('The weather is nice today.'), 'en-zh');
  assert.equal(basicDirection('今天天气很好。'), 'zh-en');
  assert.equal(basicDirection('报告', 'zh-en'), 'zh-en');
  for (const text of ['こんにちは。', '안녕하세요.', 'Здравствуйте.', 'Bonjour, comment allez-vous ?', 'Hola, ¿cómo estás?']) assert.throws(() => basicDirection(text), /AI 翻译/);
  assert.throws(() => basicDirection('Bonjour', 'fr-zh'), /仅支持中英/);
});
