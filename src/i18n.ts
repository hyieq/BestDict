import english from '../electron/locales/en.json';
import type { Settings } from './types';

const messages: Record<string, string> = english;
export function createTranslator(locale: Settings['locale']) {
  return (message: string, parameters: Record<string, string | number> = {}) => {
    let result = locale === 'en' ? messages[message] || message : message;
    if (locale === 'en' && result === message) {
      const patterns = [
        [/^正在建立索引 · ([\d,]+) 词条$/, '正在建立索引 · {count} 词条', 'count'],
        [/^正在准备 (\w+) 模型…$/, '正在准备 {pair} 模型…', 'pair'],
        [/^正在安装 (\w+) 模型…$/, '正在安装 {pair} 模型…', 'pair'],
        [/^输入内容不能超过 ([\d,]+) 个字符。$/, '输入内容不能超过 {count} 个字符。', 'count'],
        [/^(.+) 已被占用，请在设置中更换。$/, '{shortcut} 已被占用，请在设置中更换。', 'shortcut'],
        [/^本地翻译服务返回 (\d+)，请缩短文本后重试。$/, '本地翻译服务返回 {code}，请缩短文本后重试。', 'code'],
      ] as const;
      for (const [pattern, key, parameter] of patterns) {
        const match = message.match(pattern);
        if (match) { result = messages[key].replace(`{${parameter}}`, match[1]); break; }
      }
    }
    return result.replace(/\{(\w+)\}/g, (original, key: string) => String(parameters[key] ?? original));
  };
}
