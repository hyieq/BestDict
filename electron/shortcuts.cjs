const { normalizeShortcut } = require('./shortcut-policy.mjs');
class ShortcutManager {
  constructor(native, callbacks, platform) {
    this.native = native; this.callbacks = callbacks; this.platform = platform;
    this.current = {}; this.invalid = {}; this.owned = new Set(); this.errors = {}; this.suspended = false;
  }
  release() { for (const value of this.owned) this.native.unregister(value); this.owned.clear(); }
  acquire(values, partial = false, invalid = this.invalid) {
    this.errors = { ...invalid };
    for (const key of Object.keys(this.callbacks)) {
      if (!(key in values)) continue;
      const value = values[key];
      let ready = false;
      try { ready = this.native.register(value, () => { if (!this.suspended) this.callbacks[key](); }); } catch {}
      if (ready) this.owned.add(value);
      else {
        this.errors[key] = '这个快捷键已被其他程序占用，请换一个组合。';
        if (!partial) { const error = new Error(this.errors[key]); error.shortcutKey = key; throw error; }
      }
    }
  }
  configure(settings, { partial = false } = {}) {
    const values = {}, invalid = {};
    for (const key of Object.keys(this.callbacks)) {
      try { values[key] = normalizeShortcut(settings[key], this.platform); }
      catch (error) { if (partial) invalid[key] = error.message; else { error.shortcutKey = key; throw error; } }
    }
    const seen = new Set();
    for (const key of Object.keys(values)) {
      if (seen.has(values[key])) { if (!partial) throw new Error('两个快捷键不能相同。'); invalid[key] = '两个快捷键不能相同。'; delete values[key]; }
      else seen.add(values[key]);
    }
    const previous = this.current;
    this.release();
    try { this.acquire(values, partial, invalid); this.current = values; this.invalid = invalid; if (this.suspended) this.release(); }
    catch (error) { this.release(); if (!this.suspended && Object.keys(previous).length) this.acquire(previous, true); throw error; }
    return values;
  }
  suspend() { this.suspended = true; this.release(); }
  resume() {
    if (!this.suspended) return;
    this.suspended = false; this.acquire(this.current, true);
  }
  check(value) {
    if (!this.suspended) throw new Error('请先激活快捷键输入框。');
    const normalized = normalizeShortcut(value, this.platform);
    let ready = false;
    try { ready = this.native.register(normalized, () => {}); } catch {}
    if (!ready) throw new Error('这个快捷键已被其他程序占用，请换一个组合。');
    this.native.unregister(normalized);
    return normalized;
  }
}
module.exports = { ShortcutManager };
