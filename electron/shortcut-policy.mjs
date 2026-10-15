const keys = ['shortcut', 'miniShortcut', 'captureShortcut'];
export function defaultShortcuts(platform) {
  return platform === 'darwin' ? { shortcut: 'Command+Shift+D', miniShortcut: 'Command+Shift+E', captureShortcut: 'Command+Shift+S' } :
    { shortcut: 'Control+Shift+D', miniShortcut: 'Alt+Shift+D', captureShortcut: 'Alt+Shift+S' };
}
export function migrateShortcuts(settings, platform) {
  const result = { ...settings };
  if (platform === 'darwin' && settings.shortcutPlatform !== 'darwin') {
    const old = defaultShortcuts('win32'), current = defaultShortcuts(platform);
    const same = (a, b) => { try { return normalizeShortcut(a, platform) === normalizeShortcut(b, platform); } catch { return a === b; } };
    for (const key of keys) if ((!result[key] || same(result[key], old[key])) && !keys.some(other => other !== key && same(result[other], current[key]))) result[key] = current[key];
  }
  return { ...result, shortcutDefaultsVersion: 1, shortcutPlatform: platform };
}
export function normalizeShortcut(value, platform) {
  if (typeof value !== 'string') throw new Error('快捷键格式无效。');
  const parts = value.split('+'), key = parts.pop();
  if (!key || !/^(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4]))$/.test(key) || !parts.length || parts.length > 4 || parts.some(p => !['Control', 'Alt', 'Shift', 'Command', 'Super'].includes(p)) || new Set(parts).size !== parts.length) throw new Error('请使用修饰键加字母、数字或 F1–F24。');
  const modifiers = new Set(parts.map(p => platform === 'darwin' && p === 'Super' ? 'Command' : p));
  if (platform !== 'darwin' && modifiers.has('Command')) throw new Error('当前系统请使用 Ctrl、Alt、Shift 或 Win。');
  const normalized = [...['Control', 'Alt', 'Shift', 'Command', 'Super'].filter(p => modifiers.has(p)), key].join('+');
  const reserved = platform === 'darwin' ? ['Command+Q', 'Shift+Command+Q', 'Alt+Shift+Command+Q', 'Control+Command+Q', 'Command+W', 'Command+H', 'Command+M', 'Alt+Command+D'] : ['Alt+F4', 'Super+L', 'Super+D'];
  if (reserved.includes(normalized)) throw new Error('这是系统或窗口保留的组合，请换一个快捷键。');
  return normalized;
}
export function formatShortcut(value, platform) {
  const names = platform === 'darwin' ? { Control: '⌃', Alt: '⌥', Shift: '⇧', Command: '⌘', Super: '⌘' } : { Control: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Command: '⌘', Super: 'Win' };
  return value.split('+').map(part => names[part] || part).join(platform === 'darwin' ? ' ' : ' + ');
}
export function shortcutFromEvent(event, platform) {
  const modifiers = [event.ctrlKey && 'Control', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && (platform === 'darwin' ? 'Command' : 'Super')].filter(Boolean);
  if (['Control', 'Alt', 'Shift', 'Meta', 'OS'].includes(event.key)) return { preview: modifiers.join('+'), incomplete: true };
  const key = /^[a-z0-9]$/i.test(event.key) || /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(event.key) ? event.key.toUpperCase() : /^(Key[A-Z]|Digit[0-9])$/.test(event.code) && event.altKey ? event.code.replace(/^(Key|Digit)/, '') : event.key;
  const value = [...modifiers, key].join('+');
  return { preview: value, value: normalizeShortcut(value, platform), incomplete: false };
}
