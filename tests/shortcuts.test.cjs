const { test } = require('node:test');
const assert = require('node:assert/strict');
const { defaultShortcuts, migrateShortcuts, normalizeShortcut, formatShortcut, shortcutFromEvent } = require('../electron/shortcut-policy.mjs');
const { ShortcutManager } = require('../electron/shortcuts.cjs');
function fixture() {
  const bindings = new Map(), external = new Set(); let calls = 0;
  const native = { register(value, callback) { if (bindings.has(value) || external.has(value)) return false; bindings.set(value, callback); return true; }, unregister(value) { bindings.delete(value); } };
  const manager = new ShortcutManager(native, { shortcut: () => calls++, miniShortcut: () => calls++ }, 'win32');
  const initial = { shortcut: 'Control+Shift+D', miniShortcut: 'Alt+Shift+D' }; manager.configure(initial);
  return { manager, bindings, external, initial, calls: () => calls };
}
test('platform defaults migrate only legacy Mac defaults and preserve custom bindings', () => {
  assert.equal(defaultShortcuts('win32').shortcut, 'Control+Shift+D');
  const defaults = defaultShortcuts('darwin'); assert.equal(defaults.shortcut, 'Command+Shift+D');
  assert.equal(defaults.miniShortcut, 'Command+Shift+E');
  const migrated = migrateShortcuts({ ...defaultShortcuts('win32'), miniShortcut: 'Control+Alt+K' }, 'darwin');
  assert.equal(migrated.shortcut, defaults.shortcut); assert.equal(migrated.miniShortcut, 'Control+Alt+K');
  assert.equal(migrateShortcuts({ ...defaults, shortcut: 'Control+Shift+D', shortcutPlatform: 'darwin' }, 'darwin').shortcut, 'Control+Shift+D');
  const conflict = migrateShortcuts({ ...defaultShortcuts('win32'), miniShortcut: 'Command+Shift+D' }, 'darwin');
  assert.equal(conflict.shortcut, 'Control+Shift+D');
  assert.equal(formatShortcut('Command+Alt+Shift+D', 'darwin'), '⌘ ⌥ ⇧ D');
  assert.equal(formatShortcut('Control+Alt+Shift+D', 'win32'), 'Ctrl + Alt + Shift + D');
});
test('recorded keys normalize Option-modified letters, aliases, duplicates and reserved combinations', () => {
  const base = { ctrlKey: false, altKey: true, shiftKey: false, metaKey: true };
  assert.equal(shortcutFromEvent({ ...base, key: '˚', code: 'KeyK' }, 'darwin').value, 'Alt+Command+K');
  assert.equal(shortcutFromEvent({ ...base, key: 'Meta', code: 'MetaLeft' }, 'darwin').incomplete, true);
  assert.equal(normalizeShortcut('Super+Shift+D', 'darwin'), normalizeShortcut('Command+Shift+D', 'darwin'));
  for (const value of ['D', 'Control', 'Control+Control+D', 'Alt+F4', 'Super+L', 'Control+F25', 'Control+Enter']) assert.throws(() => normalizeShortcut(value, 'win32'));
  assert.throws(() => normalizeShortcut('Command+Q', 'darwin'), /保留/);
});
test('recording suspends every owned shortcut, checks occupancy without firing callbacks, and resumes saved choices', () => {
  const f = fixture(), callback = f.bindings.get(f.initial.shortcut); f.manager.suspend();
  assert.equal(f.bindings.size, 0); callback(); assert.equal(f.calls(), 0);
  assert.equal(f.manager.check(f.initial.shortcut), 'Control+Shift+D'); assert.equal(f.bindings.size, 0);
  f.external.add('Control+Alt+K'); assert.throws(() => f.manager.check('Control+Alt+K'), /占用/);
  assert.equal(f.external.has('Control+Alt+K'), true);
  f.manager.resume(); assert.equal(f.bindings.size, 2); f.bindings.get(f.initial.shortcut)(); assert.equal(f.calls(), 1);
});
test('saving while recording keeps shortcuts suspended; failed saves restore the complete previous configuration', () => {
  const f = fixture(); f.manager.suspend(); const next = { shortcut: 'Control+Shift+E', miniShortcut: 'Alt+Shift+E' };
  f.manager.configure(next); assert.equal(f.bindings.size, 0); f.manager.resume(); assert.equal(f.bindings.size, 2);
  f.external.add('Control+Alt+K');
  assert.throws(() => f.manager.configure({ shortcut: 'Control+Shift+F', miniShortcut: 'Control+Alt+K' }), /占用/);
  assert.equal(f.bindings.has(next.shortcut), true); assert.equal(f.bindings.has(next.miniShortcut), true); assert.equal(f.bindings.has('Control+Shift+F'), false);
  assert.throws(() => f.manager.configure({ shortcut: 'Control+Shift+E', miniShortcut: 'Shift+Control+E' }), /不能相同/);
});
test('restoration reports a shortcut taken by another application while preserving other bindings', () => {
  const f = fixture(); f.manager.suspend(); f.external.add(f.initial.shortcut); f.manager.resume();
  assert.equal(f.manager.suspended, false); assert.match(f.manager.errors.shortcut, /占用/);
  assert.equal(f.bindings.has(f.initial.miniShortcut), true);
});

test('a legacy reserved or malformed binding is reported without preventing startup or losing the other bindings', () => {
  const bindings = new Map();
  const native = { register(value, callback) { bindings.set(value, callback); return true; }, unregister(value) { bindings.delete(value); } };
  const manager = new ShortcutManager(native, { shortcut() {}, miniShortcut() {} }, 'darwin');
  manager.configure({ shortcut: 'Command+Q', miniShortcut: 'Command+Shift+E' }, { partial: true });
  assert.match(manager.errors.shortcut, /保留/); assert.equal(bindings.has('Command+Q'), false); assert.equal(bindings.size, 1);
  manager.suspend(); manager.resume(); assert.match(manager.errors.shortcut, /保留/); assert.equal(bindings.size, 1);
});
