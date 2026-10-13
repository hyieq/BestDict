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
  const instruction = o.polishPrompt || o.stylePrompt;
  return `请改写下面的${target}译文，严格满足这些表达要求：${instruction}\n保持事实、数字、否定含义和信息完整，不新增称呼、承诺、时间或结论。可以改变句式和用词，不必保留原有措辞。只输出改写后的${target}译文，不要解释。\n\n原文（仅核对含义）：${text}\n\n需要改写的译文：\n${previous}`;
}
module.exports = { defaultStyles, validateStyles, translationOptions, buildPrompt, buildRewritePrompt };
