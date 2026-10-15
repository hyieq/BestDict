const { buildPrompt, buildRewritePrompt, translationOptions, defaultStyles, matchesTargetLanguage } = require('./ai-options.cjs');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { randomBytes } = require('node:crypto');

const targetNames = { zh: '中文', en: '英语', es: '西班牙语', ja: '日语', ko: '韩语', fr: '法语' };
function translationDirection(text, direction, sourceHint = 'en') {
  if (direction !== 'auto') {
    const [source, target] = direction.split('-');
    if (!targetNames[source] || !targetNames[target]) throw new Error('不支持的翻译方向。');
    return { direction, target, targetName: targetNames[target] };
  }
  const hasKana = /[\u3040-\u30ff]/.test(text);
  const hasHangul = /[\uac00-\ud7af]/.test(text);
  const hasHan = /[\u3400-\u9fff]/.test(text);
  const source = hasHangul ? 'ko' : hasKana ? 'ja' : sourceHint === 'ja' && hasHan ? 'ja' : hasHan ? 'zh' : sourceHint;
  const target = source === 'zh' ? 'en' : 'zh';
  return { direction: `${source}-${target}`, target, targetName: targetNames[target] };
}

class HyTranslator {
  constructor({ executable, modelFile, isReady }) {
    this.executable = executable;
    this.modelFile = modelFile;
    this.isReady = isReady;
    this.process = null;
    this.starting = null;
    this.controller = null;
    this.generation = 0;
    this.idleTimer = null;
    this.cache = new Map();
  }

  async start() {
    if (this.starting) return this.starting;
    if (this.process) return;
    if (!this.isReady()) throw new Error('请先在设置 → 模型与词库中下载或导入 Hy-MT2。');
    const generation = ++this.generation;
    this.starting = this.boot(generation).finally(() => { if (generation === this.generation) this.starting = null; });
    return this.starting;
  }

  async boot(generation) {
    const port = await new Promise((resolve, reject) => {
      const socket = createServer();
      socket.on('error', reject);
      socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)); });
    });
    if (generation !== this.generation) throw new Error('请求已取消');
    this.url = `http://127.0.0.1:${port}`;
    this.key = randomBytes(24).toString('hex');
    let diagnostics = '';
    let failed = null;
    const child = spawn(this.executable, ['--model', this.modelFile(), '--host', '127.0.0.1', '--port', String(port),
      '--api-key', this.key, '--ctx-size', '8192', '--threads', '6', '--threads-batch', '8', '--parallel', '1',
      '--n-gpu-layers', '0', '--no-webui', '--log-disable'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    this.process = child;
    child.stderr.on('data', data => { diagnostics = (diagnostics + data).slice(-1500); });
    child.on('error', error => { failed = error; });
    child.on('exit', code => { failed = new Error(`本地模型服务退出 (${code})。${diagnostics}`); if (this.process === child) this.process = null; });
    const started = Date.now();
    try {
      while (Date.now() - started < 120_000) {
        if (failed) throw failed;
        if (generation !== this.generation) throw new Error('请求已取消');
        try {
          const health = await fetch(this.url + '/health', { headers: { Authorization: `Bearer ${this.key}` }, signal: AbortSignal.timeout(1500) });
          if (health.ok) return;
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      throw new Error('Hy-MT2 加载超时，请检查模型和可用内存。');
    } catch (error) { if (this.process === child) this.stop(); throw error; }
  }

  async translate(text, direction, hint, options = {}) {
    this.cancel();
    clearTimeout(this.idleTimer);
    const controller = new AbortController();
    this.controller = controller;
    const route = translationDirection(text, direction, hint);
    const { forceRefresh, ...normalized } = translationOptions(options);
    const key = JSON.stringify([text, route.direction, normalized]);
    try {
      if (!forceRefresh && this.cache.has(key)) return { ...this.cache.get(key), direction: route.direction, targetLanguage: route.targetName, cached: true, engine: 'Hy-MT2' };
      await this.start();
      if (controller.signal.aborted) throw new Error('请求已取消');
      const generate = async content => {
      const response = await fetch(this.url + '/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.key}` },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]),
        body: JSON.stringify({ model: 'hy-mt2', messages: [{ role: 'user',
          content }],
          temperature: 0.7, top_p: 0.6, top_k: 20, repeat_penalty: 1.05, max_tokens: 4096, stream: false, seed: 42 }),
      });
      if (!response.ok) throw new Error(`本地翻译服务返回 ${response.status}，请缩短文本后重试。`);
      const data = await response.json();
      const choice = data.choices?.[0];
      if (choice?.finish_reason === 'length') throw new Error('译文超出模型输出长度，请分段翻译。');
      const translated = choice?.message?.content?.trim();
      if (!translated) throw new Error('模型未返回译文，请重试。');
      if (controller.signal.aborted) throw new Error('请求已取消');
      return translated;
      };
      const valid = output => matchesTargetLanguage(output, route.target);
      const basicTranslation = async () => {
        let output = await generate(buildPrompt(text, route.targetName, {}));
        if (!valid(output)) output = await generate(`Translate the following text into ${targetNames[route.target]} only. Do not copy or paraphrase it in its original language. Output only the translation.\n${text}\nOutput language: ${targetNames[route.target]}`);
        if (!valid(output)) throw new Error('模型未返回目标语言的译文，请重新翻译。');
        return output;
      };
      let translated, notice = '', styleApplied = true;
      const rewrite = normalized.polishPrompt || (normalized.stylePrompt && normalized.stylePrompt !== defaultStyles[0].prompt);
      const base = normalized.polishPrompt && normalized.previousText && valid(normalized.previousText) ? normalized.previousText : await basicTranslation();
      translated = base;
      if (rewrite) {
        const rewritten = await generate(buildRewritePrompt(text, route.targetName, base, normalized));
        if (valid(rewritten)) translated = rewritten;
        else { notice = '风格或润色结果语言有误，已保留原目标语言译文。'; styleApplied = false; }
      }
      // Failed rewrites are not cached, so retrying can recover rather than replaying a bad result.
      if (styleApplied) {
        this.cache.set(key, { text: translated, styleApplied });
        if (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value);
      }
      return { text: translated, direction: route.direction, targetLanguage: route.targetName, cached: false, engine: 'Hy-MT2', styleApplied, notice };

    } finally {
      if (this.controller === controller) {
        this.controller = null;
        this.idleTimer = setTimeout(() => this.stop(), 60_000);
        this.idleTimer.unref();
      }
    }
  }

  cancel() { this.controller?.abort(); }
  stop() {
    this.cancel();
    clearTimeout(this.idleTimer);
    this.generation++;
    this.process?.kill();
    this.process = null;
    this.starting = null;
  }
}

module.exports = { HyTranslator, translationDirection };
