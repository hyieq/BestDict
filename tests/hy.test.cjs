const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { HyTranslator, translationDirection } = require('../electron/hy.cjs');

test('HY translation directions respect explicit targets and distinguish Japanese, Korean and Chinese', () => {
  assert.equal(translationDirection('你好', 'auto').direction, 'zh-en');
  assert.equal(translationDirection('こんにちは', 'auto').direction, 'ja-zh');
  assert.equal(translationDirection('사랑', 'auto').direction, 'ko-zh');
  assert.equal(translationDirection('猫', 'auto', 'ja').direction, 'ja-zh');
  assert.equal(translationDirection('Bonjour', 'fr-zh').targetName, '中文');
  assert.equal(translationDirection('你好', 'zh-es').targetName, '西班牙语');
  assert.throws(() => translationDirection('hi', 'invalid-language'), /不支持/);
});

test('uninstalled HY model gives an actionable error without starting a process', async () => {
  const hy = new HyTranslator({ executable: '', modelFile: () => '', isReady: () => false });
  await assert.rejects(hy.translate('Hello', 'en-zh', 'en'), /下载或导入/);
  assert.equal(hy.process, null);
  hy.stop();
});

const model = path.resolve('.cache/validation-library/hy-mt2/Hy-MT2-1.8B-Q4_K_M.gguf');
test('real MT2 styles and polishing preserve the report deadline', { skip: process.env.BESTDICT_REAL_ASSETS !== '1' || !fs.existsSync(model), timeout: 120000 }, async () => {
  const { defaultStyles } = require('../electron/ai-options.cjs');
  const hy = new HyTranslator({ executable: path.resolve('runtime/llama/llama-server.exe'), modelFile: () => model, isReady: () => true });
  const text = 'Please send me the report before Friday. We need it for the meeting.';
  try {
    let previous;
    const outputs = [];
    for (const style of defaultStyles) {
      previous = await hy.translate(text, 'en-zh', 'en', { styleName: style.name, stylePrompt: style.prompt });
      outputs.push(previous.text);
      assert.match(previous.text, /报告/);
      assert.match(previous.text, /周五|星期五/);
      assert.match(previous.text, /会议|开会/);
      console.log(JSON.stringify({ style: style.name, result: previous.text }));
    }
    assert.notEqual(outputs[1], outputs[2], 'Professional and conversational styles should differ on this sample.');
    const polished = await hy.translate(text, 'en-zh', 'en', { polishPrompt: '像同事聊天一样简洁自然，保留截止时间和用途。', previousText: previous.text });
    assert.match(polished.text, /周五|星期五/);
    assert.match(polished.text, /报告/);
    console.log(JSON.stringify({ polished: polished.text }));
  } finally { hy.stop(); }
});
test('real HY CPU inference, multilingual translation and caching', { skip: process.env.BESTDICT_REAL_ASSETS !== '1' || !fs.existsSync(model), timeout: 120000 }, async () => {
  const hy = new HyTranslator({ executable: path.resolve('runtime/llama/llama-server.exe'), modelFile: () => model, isReady: () => true });
  try {
    const english = await hy.translate('Please send me the report before Friday.', 'en-zh', 'en');
    assert.match(english.text, /报告/);
    assert.match(english.text, /周五|星期五/);
    for (const [text, direction] of [['Hola, ¿cómo estás?', 'es-zh'], ['こんにちは。今日はいい天気ですね。', 'ja-zh'], ['안녕하세요. 오늘 날씨가 좋네요.', 'ko-zh'], ['Bonjour, comment allez-vous ?', 'fr-zh']]) {
      const output = await hy.translate(text, direction, 'en');
      assert.match(output.text, /[\u3400-\u9fff]/);
      assert.ok(!output.text.includes('▁'));
      console.log(JSON.stringify({ direction, text: output.text }));
    }
    const backward = await hy.translate('我想做一个简单好用的词典软件。', 'zh-en', 'zh');
    assert.match(backward.text.toLowerCase(), /dictionary/);
    const cached = await hy.translate('我想做一个简单好用的词典软件。', 'zh-en', 'zh');
    assert.equal(cached.cached, true);
  } finally { hy.stop(); }
});
