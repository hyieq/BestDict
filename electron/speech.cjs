const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { WorkerClient } = require('./worker.cjs');
const { kokoroVoices, validateSpeech, selectSystemVoice } = require('./speech-options.cjs');

class SpeechService {
  constructor({ python, backend, resources, platform = process.platform }) {
    this.backend = backend;
    this.resources = resources;
    this.platform = platform;
    this.worker = new WorkerClient(python, path.join(backend, 'speech_worker.py'), resources.kokoroRoot(), 'speech');
    this.children = new Set();
    this.revision = 0;
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

  cancel() {
    this.revision++;
    this.abort?.abort();
    this.abort = null;
    return this.worker.stop();
  }

  async synthesize(text, language, preferences) {
    if (typeof text !== 'string' || !text.trim() || text.length > 10000 || !/^[a-z]{2,3}$/.test(language)) throw new Error('发音文本或语言无效（最多 10,000 字符）。');
    const options = validateSpeech(preferences);
    const revision = this.revision + 1;
    await this.cancel();
    if (revision !== this.revision) throw new Error('发音已停止。');
    const abort = new AbortController();
    this.abort = abort;
    const check = () => { if (revision !== this.revision || abort.signal.aborted) throw new Error('发音已停止。'); };
    try {
      const supported = ['en', 'zh'].includes(language);
      const ready = this.resources.kokoroStatus().ready;
      if (options.engine === 'kokoro' && supported && !ready) throw new Error('请先在设置中下载中英离线语音包。');
      if (options.engine !== 'system' && supported && ready) {
        const result = await this.worker.request('synthesize', { text, language, voice: options.kokoroVoices[language], rate: options.rate }, { timeout: 180_000 });
        check();
        return result;
      }
      const voices = await this.voices();
      check();
      const voice = selectSystemVoice(voices, language, options.systemVoices[language]);
      if (this.platform === 'win32') {
        const audio = await this.windows({ method: 'synthesize', text, voice: voice.id, rate: options.rate }, abort.signal);
        check();
        return { audio, engine: 'system' };
      }
      if (this.platform === 'darwin') {
        const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'bestdict-speech-'));
        const output = path.join(folder, 'speech.wav');
        try {
          check();
          await this.run('/usr/bin/say', ['-v', voice.id, '-r', String(Math.round(180 * options.rate)), '-o', output, '--file-format=WAVE', '--data-format=LEI16@22050', '-f', '-'], text, abort.signal);
          check();
          return { audio: (await fs.readFile(output)).toString('base64'), engine: 'system' };
        } finally { await fs.unlink(output).catch(() => {}); await fs.rmdir(folder).catch(() => {}); }
      }
      throw new Error('当前平台没有可用的系统语音。');
    } finally { if (this.abort === abort) this.abort = null; }
  }
  stop() { this.cancel(); for (const child of this.children) child.kill(); }
}
module.exports = { SpeechService };
