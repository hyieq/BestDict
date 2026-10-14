const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { WorkerClient } = require('./worker.cjs');
const { kokoroVoices, validateSpeech, selectSystemVoice } = require('./speech-options.cjs');
const { SpeechCache, MAX_BYTES, MAX_ENTRIES } = require('./speech-cache.cjs');

class SpeechService {
  constructor({ python, backend, resources, platform = process.platform, cacheDirectory, cacheLimits, standbyTimeout = 120_000 }) {
    this.backend = backend;
    this.resources = resources;
    this.platform = platform;
    this.worker = new WorkerClient(python, path.join(backend, 'speech_worker.py'), resources.kokoroRoot(), 'speech', { idleTimeout: standbyTimeout });
    this.children = new Set();
    this.revision = 0;
    this.modelRevision = 0;
    this.warmup = null;
    this.prepared = null;
    this.suspended = false;
    this.cache = cacheDirectory ? new SpeechCache(cacheDirectory, cacheLimits) : null;
  }

  cacheStatus() { return this.cache?.status() || Promise.resolve({ bytes: 0, count: 0, maxBytes: MAX_BYTES, maxEntries: MAX_ENTRIES }); }
  clearCache() { return this.cache?.clear() || this.cacheStatus(); }

  async setActive(active, preferences) {
    const options = validateSpeech(preferences);
    const enabled = !this.suspended && options.engine !== 'system' && this.resources.kokoroStatus().ready;
    this.worker.keepAlive = active && enabled;
    this.worker.armIdle();
    if (!enabled) {
      // Activation manages model residency; it must not cancel system speech
      // (or a manually selected preview) that is already being generated.
      if (this.abort) return;
      this.modelRevision++;
      this.prepared = null;
      return this.worker.stop();
    }
    if (!active) return this.cancel();
    return this.prepare(options);
  }

  prepare(options) {
    if (this.suspended || options.engine === 'system' || !this.resources.kokoroStatus().ready) return Promise.resolve();
    // American voices share one model/lexicon, as do the selected Chinese voices.
    const voice = options.kokoroVoices.en === 2 ? 2 : 0;
    if (!this.warmup && this.prepared?.voice === voice && this.prepared.child === this.worker.process && this.worker.process) return Promise.resolve();
    if (this.warmup?.voice === voice && this.warmup.revision === this.modelRevision) return this.warmup.promise;
    const task = { voice, revision: this.modelRevision };
    this.warmup = task;
    task.promise = (async () => {
      await this.worker.stopping;
      if (task.revision !== this.modelRevision) throw new Error('发音已停止。');
      const request = this.worker.request('prepare', { voice }, { timeout: 180_000 });
      const child = this.worker.process;
      await request;
      if (task.revision !== this.modelRevision) throw new Error('发音已停止。');
      this.prepared = { voice, child };
    })().finally(() => { if (this.warmup === task) this.warmup = null; });
    return task.promise;
  }

  suspend() { this.suspended = true; this.worker.keepAlive = false; return this.cancel({ unload: true }); }

  async cachedAudio(parameters, produce, check, generation = this.cache?.generation) {
    const key = this.cache?.key(parameters);
    const audio = key ? await this.cache.get(key).catch(() => null) : null;
    check();
    if (audio) return { audio, engine: parameters.engine, cached: true };
    const result = await produce();
    check();
    // Cache failures must not prevent playing freshly generated audio.
    if (key) await this.cache.put(key, result.audio, generation).catch(() => {});
    check();
    return { ...result, cached: false };
  }

  run(command, args, input = '', signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('发音已停止。'));
      const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      this.children.add(child);
      let output = '', error = '', settled = false;
      const finish = (reason, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.children.delete(child);
        if (reason) reject(reason); else resolve(value);
      };
      const abort = () => { child.kill(); finish(new Error('发音已停止。')); };
      const timer = setTimeout(() => { child.kill(); finish(new Error('发音处理超时，请缩短文本后重试。')); }, 120_000);
      signal?.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', data => {
        output += data.toString('utf8');
        if (output.length > 64 * 1024 * 1024) { child.kill(); finish(new Error('音频过长，请缩短文本。')); }
      });
      child.stderr.on('data', data => { error = (error + data.toString('utf8')).slice(-1000); });
      child.once('error', e => finish(e));
      child.stdin.on('error', e => finish(e));
      child.once('close', code => finish(code === 0 ? null : new Error(`系统语音不可用：${error || code}`), output.trim()));
      child.stdin.end(input, 'utf8');
    });
  }

  windows(request, signal) {
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return this.run(executable, ['-NoProfile', '-NonInteractive', '-File', path.join(this.backend, 'system_speech.ps1')], JSON.stringify(request), signal);
  }

  async voices() {
    if (this.platform === 'win32') return JSON.parse(await this.windows({ method: 'voices' }));
    if (this.platform === 'darwin') {
      const output = await this.run('/usr/bin/say', ['-v', '?']);
      return output.split('\n').flatMap(line => {
        const match = line.match(/^(.+?)\s+([a-z]{2,3}[_-][A-Za-z_]+)\s+#/);
        return match ? [{ id: match[1].trim(), name: match[1].trim(), language: match[2].replace(/_/g, '-') }] : [];
      });
    }
    return [];
  }

  async catalog() {
    let voices = [], systemError = '';
    try { voices = await this.voices(); } catch { systemError = '无法读取系统音色，请检查系统语音组件。'; }
    return { system: voices, kokoro: kokoroVoices, systemError };
  }

  cancel({ unload = false } = {}) {
    this.revision++;
    this.abort?.abort();
    this.abort = null;
    // Stopping playback must not discard an idle model or interrupt background preparation.
    // Real inference is synchronous in Python, so cancelling it still terminates its process.
    if (unload || [...this.worker.pending.values()].some(task => task.method === 'synthesize')) {
      this.modelRevision++;
      this.prepared = null;
      return this.worker.stop();
    }
    return this.worker.stopping;
  }

  async synthesize(text, language, preferences, { onChunk } = {}) {
    if (typeof text !== 'string' || !text.trim() || text.length > 10000 || !/^[a-z]{2,3}$/.test(language)) throw new Error('发音文本或语言无效（最多 10,000 字符）。');
    const options = validateSpeech(preferences);
    const cacheGeneration = this.cache?.generation;
    const revision = this.revision + 1;
    await this.cancel();
    if (revision !== this.revision) throw new Error('发音已停止。');
    const abort = new AbortController();
    this.abort = abort;
    const check = () => { if (revision !== this.revision || abort.signal.aborted) throw new Error('发音已停止。'); };
    try {
      const supported = ['en', 'zh'].includes(language);
      const model = this.resources.kokoroStatus();
      const ready = model.ready && !this.suspended;
      if (options.engine === 'kokoro' && supported && !ready) throw new Error('请先在设置中下载中英离线语音包。');
      if (options.engine !== 'system' && supported && ready) {
        const voice = options.kokoroVoices[language];
        const singleWord = /^[A-Za-zÀ-ɏ0-9]+(?:['’./-][A-Za-zÀ-ɏ0-9]+)*$/.test(text.trim()) || /^[\u4e00-\u9fff]{1,8}$/.test(text.trim());
        const pureChinese = /^[\u4e00-\u9fff\s。，！？；：、（）“”‘’「」『』]+$/.test(text);
        return await this.cachedAudio({ engine: 'kokoro', model: model.sha256, text, language, voice, rate: options.rate,
          ...(!singleWord ? { pipeline: 1 } : {}),
          ...(language === 'zh' && !pureChinese ? { englishAccent: options.kokoroVoices.en === 2 ? 'gb' : 'us' } : {}) },
          async () => {
            await this.prepare(options);
            check();
            const request = this.worker.request('synthesize', { text, language, voice, englishVoice: options.kokoroVoices.en, rate: options.rate, stream: !!onChunk }, {
              timeout: 180_000,
              onEvent: chunk => { if (revision === this.revision && !abort.signal.aborted) onChunk?.(chunk); },
            });
            const child = this.worker.process;
            const result = await request;
            check();
            // A preview can select a different accent while background preparation is queued.
            const preparedVoice = options.kokoroVoices.en === 2 ? 2 : 0;
            if (this.prepared?.voice !== preparedVoice || this.prepared.child !== child) this.prepared = { voice: preparedVoice, child };
            return result;
          }, check, cacheGeneration);
      }
      const voices = await this.voices();
      check();
      const voice = selectSystemVoice(voices, language, options.systemVoices[language]);
      if (this.platform === 'win32') {
        return await this.cachedAudio({ engine: 'system', platform: this.platform, system: os.release(), text, language, voice: voice.id, rate: options.rate }, async () => {
          const audio = await this.windows({ method: 'synthesize', text, voice: voice.id, rate: options.rate }, abort.signal);
          return { audio, engine: 'system' };
        }, check, cacheGeneration);
      }
      if (this.platform === 'darwin') {
        return await this.cachedAudio({ engine: 'system', platform: this.platform, system: os.release(), text, language, voice: voice.id, rate: options.rate }, async () => {
          const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'bestdict-speech-'));
          const output = path.join(folder, 'speech.wav');
          try {
            check();
            await this.run('/usr/bin/say', ['-v', voice.id, '-r', String(Math.round(180 * options.rate)), '-o', output, '--file-format=WAVE', '--data-format=LEI16@22050', '-f', '-'], text, abort.signal);
            check();
            return { audio: (await fs.readFile(output)).toString('base64'), engine: 'system' };
          } finally { await fs.unlink(output).catch(() => {}); await fs.rmdir(folder).catch(() => {}); }
        }, check, cacheGeneration);
      }
      throw new Error('当前平台没有可用的系统语音。');
    } finally { if (this.abort === abort) this.abort = null; }
  }
  stop() { this.worker.keepAlive = false; const stopped = this.cancel({ unload: true }); for (const child of this.children) child.kill(); return stopped; }
}
module.exports = { SpeechService };
