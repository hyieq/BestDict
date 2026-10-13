const defaultSpeech = { engine: 'auto', rate: 1, systemVoices: {}, kokoroVoices: { en: 0, zh: 3 } };
const kokoroVoices = [
  { id: '0', name: 'Maple · 美式女声', language: 'en' },
  { id: '1', name: 'Sol · 美式女声', language: 'en' },
  { id: '2', name: 'Vale · 英式女声', language: 'en' },
  { id: '3', name: '001 · 中文女声', language: 'zh' },
  { id: '58', name: '009 · 中文男声', language: 'zh' },
];
function validateSpeech(value) {
  if (!value || !['auto', 'system', 'kokoro'].includes(value.engine) || typeof value.rate !== 'number' || !Number.isFinite(value.rate) || value.rate < .5 || value.rate > 2) throw new Error('发音设置无效。');
  const systemVoices = {};
  if (!value.systemVoices || typeof value.systemVoices !== 'object' || Array.isArray(value.systemVoices)) throw new Error('发音设置无效。');
  for (const [language, voice] of Object.entries(value.systemVoices)) {
    if (!/^[a-z]{2,3}$/.test(language) || typeof voice !== 'string' || voice.length > 200) throw new Error('发音设置无效。');
    systemVoices[language] = voice;
  }
  for (const language of ['en', 'zh']) {
    if (!kokoroVoices.some(v => v.language === language && Number(v.id) === value.kokoroVoices?.[language])) throw new Error('发音设置无效。');
  }
  return { engine: value.engine, rate: value.rate, systemVoices, kokoroVoices: { en: value.kokoroVoices.en, zh: value.kokoroVoices.zh } };
}
function selectSystemVoice(voices, language, preferred) {
  const candidates = voices.filter(v => v.language.split(/[-_]/)[0].toLowerCase() === language);
  const voice = candidates.find(v => v.id === preferred) || candidates[0];
  if (!voice) throw new Error('系统未安装该语言的音色，请在系统设置中安装语音，或下载中英离线语音包。');
  return voice;
}
module.exports = { defaultSpeech, kokoroVoices, validateSpeech, selectSystemVoice };
