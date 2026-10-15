const defaultStyles = [
  { id: 'basic', name: '基本', prompt: '忠实传达原意，表达自然、清晰，保留原文语气。' },
  { id: 'professional', name: '专业', prompt: '使用正式、严谨的书面表达，结合语境采用准确术语，保持术语一致。' },
  { id: 'casual', name: '口语化', prompt: '使用自然的日常交流表达，句式简洁流畅，避免生硬书面语，保留原文语气。' },
  { id: 'concise', name: '简短', prompt: '用简短直接的句子表达，删去冗余措辞，保留原文的关键信息、事实、数字、条件和否定含义，不添加解释。' },
];
function validateStyles(styles) {
  if (!Array.isArray(styles) || !styles.length || styles.length > 30) throw new Error('请保留 1–30 个翻译风格。');
  const ids = new Set();
  for (const style of styles) {
    if (!style || typeof style.id !== 'string' || !/^[\w-]{1,80}$/.test(style.id) || ids.has(style.id) ||
      typeof style.name !== 'string' || !style.name.trim() || style.name.length > 30 ||
      typeof style.prompt !== 'string' || !style.prompt.trim() || style.prompt.length > 1000) throw new Error('风格名称或提示词无效。');
    ids.add(style.id);
  }
  return styles.map(({ id, name, prompt }) => ({ id, name: name.trim(), prompt: prompt.trim() }));
}
function translationOptions(options = {}) {
  const result = { forceRefresh: options?.forceRefresh === true };
  for (const [key, limit] of Object.entries({ styleName: 30, stylePrompt: 1000, polishPrompt: 1000, previousText: 20000 })) {
    const value = options?.[key] ?? '';
    if (typeof value !== 'string' || value.length > limit) throw new Error('AI 翻译提示词无效或过长。');
    result[key] = value.trim();
  }
  return result;
}
function buildPrompt(text, target, options = {}) {
  const o = translationOptions(options);
  return `请将〖原文〗翻译为${target}。忠实保留原文事实、数字和信息，不擅自增删，只输出最终译文，不要解释。\n` +
    (o.stylePrompt ? `〖翻译风格〗\n${o.stylePrompt}\n` : '') +
    (o.polishPrompt ? `请结合原文和参考译文，按照以下润色要求重新生成${target}译文。润色要求优先于一般风格要求，但不得改变原意。\n〖润色要求〗\n${o.polishPrompt}\n` : '') +
    (o.polishPrompt && o.previousText ? `〖参考译文〗\n${o.previousText}\n` : '') + `〖原文〗\n${text}`;
}
function buildRewritePrompt(text, target, previous, options) {
  const o = translationOptions(options);
  const names = { 中文: 'Chinese', 英语: 'English', 西班牙语: 'Spanish', 日语: 'Japanese', 韩语: 'Korean', 法语: 'French' };
  const presets = [
    'Preserve the meaning and original tone, using natural and clear wording.',
    'Use formal, precise professional wording and consistent terminology.',
    'Use natural conversational wording, short fluent sentences and the original tone.',
    'Use concise direct sentences. Retain all key facts, numbers, conditions and negation.',
  ];
  const index = defaultStyles.findIndex(style => style.prompt === o.stylePrompt);
  const instruction = o.polishPrompt || (index >= 0 ? presets[index] : o.stylePrompt);
  const language = names[target] || target;
  return `Rewrite the translation in ${language}. The output language MUST remain ${language}; language takes priority over all style requests. Do not translate back into the source language. Preserve facts, numbers, negation and meaning. Output only the rewritten translation, without explanation.\n\nStyle requirements (change wording only, never the output language):\n${instruction}\n\nSource for checking meaning only:\n${text}\n\n${language} translation to rewrite:\n${previous}\n\nOutput the final translation in ${language} only:`;
}
// This guard detects clear script mismatches, not distinctions between Latin-script languages.
function matchesTargetLanguage(text, target) {
  const count = pattern => (text.match(pattern) || []).length;
  const han = count(/\p{Script=Han}/gu), kana = count(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu), hangul = count(/\p{Script=Hangul}/gu), latin = count(/\p{Script=Latin}/gu);
  const cjk = han + kana + hangul;
  if (['en', 'es', 'fr'].includes(target)) return !(cjk >= 2 && cjk > latin * .5);
  if (target === 'zh' && (kana + hangul > han || (!han && latin >= 8 && /\s/.test(text.trim())))) return false;
  if (target === 'ja' && (hangul > han + kana || (!han && !kana && latin >= 8 && /\s/.test(text.trim())))) return false;
  if (target === 'ko' && ((han + kana >= 2 && !hangul) || (!hangul && latin >= 8 && /\s/.test(text.trim())))) return false;
  return true;
}

module.exports = { defaultStyles, validateStyles, translationOptions, buildPrompt, buildRewritePrompt, matchesTargetLanguage };
