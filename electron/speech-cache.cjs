const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const MAX_BYTES = 128 * 1024 * 1024;
const MAX_ENTRIES = 1000;
const audioName = /^[a-f0-9]{64}\.wav$/;
const temporaryName = /^[a-f0-9]{64}\.[a-f0-9-]{36}\.tmp$/;
const validAudio = audio => audio.length > 44 && audio.toString('ascii', 0, 4) === 'RIFF' && audio.toString('ascii', 8, 12) === 'WAVE' && audio.readUInt32LE(4) + 8 === audio.length;

class SpeechCache {
  constructor(directory, { maxBytes = MAX_BYTES, maxEntries = MAX_ENTRIES } = {}) {
    this.directory = directory;
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
    this.generation = 0;
    this.queue = Promise.resolve();
    this.initialized = false;
    this.clock = Date.now();
  }

  key(parameters) {
    // Names contain no query text. Bump the format when synthesis semantics change.
    return createHash('sha256').update(JSON.stringify({ format: 1, ...parameters })).digest('hex');
  }

  run(operation) {
    const result = this.queue.then(async () => {
      if (!this.initialized) {
        await fs.mkdir(this.directory, { recursive: true });
        for (const file of await fs.readdir(this.directory)) {
          if (temporaryName.test(file)) await fs.unlink(path.join(this.directory, file));
        }
        await this.prune();
        this.initialized = true;
      }
      return operation();
    });
    this.queue = result.catch(() => {});
    return result;
  }

  file(key) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid speech cache key');
    return path.join(this.directory, `${key}.wav`);
  }

  async entries() {
    const entries = [];
    for (const file of await fs.readdir(this.directory)) {
      if (!audioName.test(file)) continue;
      const location = path.join(this.directory, file);
      try {
        const stat = await fs.lstat(location);
        if (stat.isFile()) {
          this.clock = Math.max(this.clock, stat.mtimeMs);
          entries.push({ location, bytes: stat.size, used: stat.mtimeMs });
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return entries;
  }

  async prune() {
    const entries = (await this.entries()).sort((a, b) => a.used - b.used);
    let bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    let count = entries.length;
    for (const entry of entries) {
      if (bytes <= this.maxBytes && count <= this.maxEntries) break;
      await fs.unlink(entry.location);
      bytes -= entry.bytes;
      count--;
    }
    return { bytes, count, maxBytes: this.maxBytes, maxEntries: this.maxEntries };
  }

  async touch(file) {
    this.clock = Math.max(Date.now(), this.clock + 1);
    const time = new Date(this.clock);
    await fs.utimes(file, time, time);
  }

  get(key) {
    return this.run(async () => {
      const file = this.file(key);
      try {
        const stat = await fs.lstat(file);
        if (!stat.isFile()) return null;
        if (stat.size > this.maxBytes || stat.size <= 44) { await fs.unlink(file); return null; }
        const audio = await fs.readFile(file);
        if (!validAudio(audio)) { await fs.unlink(file); return null; }
        await this.touch(file);
        return audio.toString('base64');
      } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    });
  }

  put(key, base64, generation = this.generation) {
    return this.run(async () => {
      if (generation !== this.generation) return;
      const audio = Buffer.from(base64, 'base64');
      if (!validAudio(audio) || audio.length > this.maxBytes) return;
      const file = this.file(key);
      const temporary = path.join(this.directory, `${key}.${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temporary, audio, { flag: 'wx', mode: 0o600 });
        if (generation !== this.generation) return;
        await fs.rename(temporary, file);
        await this.touch(file);
        await this.prune();
      } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    });
  }

  status() { return this.run(() => this.prune()); }

  clear() {
    // Invalidate pending synthesis immediately, before waiting for disk operations.
    this.generation++;
    return this.run(async () => {
      for (const file of await fs.readdir(this.directory)) {
        if (audioName.test(file) || temporaryName.test(file)) await fs.unlink(path.join(this.directory, file));
      }
      return { bytes: 0, count: 0, maxBytes: this.maxBytes, maxEntries: this.maxEntries };
    });
  }
}

module.exports = { SpeechCache, MAX_BYTES, MAX_ENTRIES };
