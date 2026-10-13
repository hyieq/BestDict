// Conservative routing: missing dictionary phrases should not start inference.
export function isSentence(text) {
  if (/[\n。！？!?]/u.test(text)) return true;
  if (/\./u.test(text) && text.trim().split(/\s+/u).length >= 3) return true;
  if (/[\u3400-\u9fff]/u.test(text)) return text.length > 12;
  const words = text.trim().split(/\s+/u);
  return words.length >= 6 || (words.length >= 3 && /\b(?:am|is|are|was|were|have|has|will|would|can|could|should|please)\b/iu.test(text));
}

export function basicDirection(text, direction = 'auto') {
  if (direction !== 'auto') {
    if (!['en-zh', 'zh-en'].includes(direction)) throw new Error('基础翻译仅支持中英双向，请使用 AI 翻译。');
    return direction;
  }
  if (/[\u3040-\u30ff\uac00-\ud7af]/u.test(text) || /[\p{Letter}&&[^\p{Script=Latin}]]/v.test(text.replace(/[\u3400-\u9fff]/gu, ''))) {
    throw new Error('基础翻译暂不支持此语言，请使用 AI 翻译。');
  }
  const words = text.toLowerCase().match(/\p{Script=Latin}+/gu) || [];
  const french = new Set(['bonjour', 'merci', 'vous', 'nous', 'comment', 'allez', 'avec', 'une', 'est', 'les', 'des']);
  const spanish = new Set(['hola', 'gracias', 'como', 'cómo', 'estás', 'usted', 'nosotros', 'quiero', 'buenos', 'días', 'por', 'favor']);
  if ([french, spanish].some(markers => new Set(words.filter(word => markers.has(word))).size >= 2)) {
    throw new Error('基础翻译暂不支持此语言，请使用 AI 翻译。');
  }
  return /[\u3400-\u9fff]/u.test(text) ? 'zh-en' : 'en-zh';
}
