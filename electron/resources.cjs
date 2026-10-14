const fs = require('node:fs');
const path = require('node:path');
const { WorkerClient } = require('./worker.cjs');
const { downloadFile, partialBytes } = require('./download-file.cjs');

class ResourceManager {
  constructor({ assets, library, python, script, progress }) {
    this.assets = assets;
    this.library = library;
    this.catalog = JSON.parse(fs.readFileSync(path.join(assets, 'dictionaries.json'), 'utf8'));
    this.hySpec = JSON.parse(fs.readFileSync(path.join(assets, 'hy-model.json'), 'utf8'));
    this.argosSpec = JSON.parse(fs.readFileSync(path.join(assets, 'argos-model.json'), 'utf8'));
    this.kokoroSpec = JSON.parse(fs.readFileSync(path.join(assets, 'kokoro-model.json'), 'utf8'));
    this.installer = new WorkerClient(python, script, assets, 'installer');
    this.latestProgress = null;
    this.progress = data => { this.latestProgress = data; progress(data); };
    this.installer.onProgress = this.progress;
    this.activeJob = null;
  }

  metadata(id) {
    try { return JSON.parse(fs.readFileSync(path.join(this.library, id, 'metadata.json'), 'utf8')); }
    catch { return null; }
  }

  list() {
    const builtIn = { id: 'ecdict', name: '英语 ↔ 中文', languageName: '英语', languageCode: 'en', installed: true, builtIn: true,
      source: 'ECDICT', license: 'MIT', homepage: 'https://github.com/skywind3000/ECDICT', count: 770611, example: 'serendipity' };
    return [builtIn, ...this.catalog.dictionaries.map(spec => {
      const meta = this.metadata(spec.id);
      return { ...spec, installed: !!meta && meta.id === spec.id && fs.existsSync(path.join(this.library, spec.id, 'dictionary.db')),
        count: meta?.count || 0, source: this.catalog.source.name, license: this.catalog.source.license,
        homepage: this.catalog.source.homepage, downloadBytesEstimate: this.catalog.source.downloadBytesEstimate, builtIn: false };
    })];
  }

  database(id) {
    const spec = this.list().find(item => item.id === id && item.installed);
    if (!spec) throw new Error('请先下载或导入所选词库。');
    return id === 'ecdict' ? undefined : path.join(this.library, id, 'dictionary.db');
  }

  modelFile() { return path.join(this.library, 'hy-mt2', this.hySpec.filename); }

  downloadLinks(id) {
    if (id === 'argos') return this.argosSpec.packages.map(p => p.url);
    if (id === 'hy-mt2') return [this.hySpec.url];
    if (id === 'kokoro') return [this.kokoroSpec.url];
    throw new Error('资源无效。');
  }

  filesFor(id) {
    const cache = path.join(this.library, 'cache');
    if (id === 'argos') return this.argosSpec.packages.map(p => ({ ...p, target: path.join(cache, 'argos', p.filename) }));
    if (id === 'hy-mt2' || id === 'kokoro') {
      const spec = id === 'hy-mt2' ? this.hySpec : this.kokoroSpec;
      return [{ ...spec, target: path.join(cache, spec.filename) }];
    }
    if (id === 'multi-dictionaries' || this.catalog.dictionaries.some(item => item.id === id)) {
      return [{ ...this.catalog.source, filename: 'wiktionary-zh.jsonl.gz', bytes: 0, target: path.join(cache, 'wiktionary-zh.jsonl.gz') }];
    }
    throw new Error('资源无效。');
  }
  sourcesFor(id) {
    const files = this.filesFor(id);
    const choices = [{ id: 'official', name: '官方来源', urls: files.map(f => f.url) }];
    if (id === 'hy-mt2') choices.push({ id: 'hf-mirror', name: 'Hugging Face 镜像', urls: [this.hySpec.url.replace('https://huggingface.co/', 'https://hf-mirror.com/')] });
    return choices;
  }
  async download(id, options, signal) {
    const files = this.filesFor(id), sources = this.sourcesFor(id);
    const urls = resolveSources(files, sources, options);
    let completed = 0;
    const total = files.reduce((sum, f) => sum + (f.bytes || f.downloadBytesEstimate || 0), 0);
    for (const [index, file] of files.entries()) {
      await downloadFile({ urls: urls[index], target: file.target, bytes: file.bytes, sha256: file.sha256, signal,
        onProgress: event => this.progress({ id, phase: event.verifying ? 'verifying' : 'downloading',
          received: completed + (event.received || 0), total: files.length === 1 && event.total ? event.total : total,
          message: event.verifying ? '正在验证文件…' : event.retrying ? '正在重试或切换来源…' : event.restarted ? '来源不支持续传，正在重新下载…' : '正在下载…' }) });
      completed += fs.statSync(file.target).size;
    }
    return id === 'argos' ? files.map(f => f.target) : files[0].target;
  }
  pendingBytes(id) { return this.filesFor(id).reduce((n, f) => n + partialBytes(f.target), 0); }

  argosRoot() { return path.join(this.library, 'argos'); }

  kokoroRoot() { return path.join(this.library, 'kokoro', 'model'); }

  kokoroStatus() {
    const meta = this.metadata('kokoro');
    const ready = meta?.sha256 === this.kokoroSpec.sha256 && this.kokoroSpec.required.every(file => {
      try { return meta.sizes?.[file] > 0 && fs.statSync(path.join(this.kokoroRoot(), file)).size === meta.sizes[file]; } catch { return false; }
    });
    return { ...this.kokoroSpec, ready: !!ready };
  }

  argosStatus() {
    const meta = this.metadata('argos');
    const ready = this.argosSpec.packages.every(p => meta?.packages?.[p.pair] === p.sha256 &&
      ['model/model.bin', 'model/config.json', 'sentencepiece.model'].every(file => {
        try { return fs.statSync(path.join(this.argosRoot(), 'models', p.pair, file)).size > 0; } catch { return false; }
      }));
    return { ...this.argosSpec, ready };
  }

  hyStatus() {
    const meta = this.metadata('hy-mt2');
    let size = 0;
    try { size = fs.statSync(this.modelFile()).size; } catch {}
    return { ready: meta?.sha256 === this.hySpec.sha256 && size === this.hySpec.bytes, ...this.hySpec };
  }

  async install(id, sourceFile, { replace = false } = {}) {
    if (this.activeJob) throw new Error('已有资源正在安装，请等待完成或取消。');
    if (!['argos', 'hy-mt2', 'kokoro', 'multi-dictionaries'].includes(id) && !this.catalog.dictionaries.some(item => item.id === id)) throw new Error('资源无效。');
    if (id === 'argos' && this.argosStatus().ready) throw new Error('Argos 模型已经安装。');
    if (!['argos', 'hy-mt2', 'kokoro', 'multi-dictionaries'].includes(id) && this.list().find(item => item.id === id)?.installed) throw new Error('这个词库已经安装。');
    this.activeJob = id;
    this.progress({ id, phase: 'starting', message: '正在准备资源…' });
    try {
      return await this.installer.request('install', { resourceId: id, library: this.library, sourceFile,
        dictionaryIds: id === 'multi-dictionaries' ? this.list().filter(item => !item.builtIn && (replace || !item.installed)).map(item => item.id) : undefined }, { timeout: 30 * 60_000 });
    } catch (error) {
      this.progress({ id, phase: error.message.includes('取消') ? 'cancelled' : 'error', message: error.message });
      throw error;
    } finally {
      await this.installer.stop();
      // Hard cancellation does not run Python finally blocks. Clean only known staging files.
      for (const staging of ['dictionary.db.building', this.hySpec.filename + '.incoming', this.hySpec.filename + '.incoming.part']) {
        try { fs.rmSync(path.join(this.library, id, staging)); } catch {}
      }
      if (id === 'multi-dictionaries') for (const item of this.catalog.dictionaries) {
        try { fs.rmSync(path.join(this.library, item.id, 'dictionary.db.building')); } catch {}
      }
      try { fs.rmSync(path.join(this.library, 'cache', 'wiktionary-zh.jsonl.gz.part')); } catch {}
      if (id === 'kokoro') {
        const staging = path.resolve(this.library, 'kokoro', 'model.incoming');
        if (path.dirname(staging) === path.resolve(this.library, 'kokoro')) {
          try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
        }
        try { fs.rmSync(path.join(this.library, 'cache', this.kokoroSpec.filename + '.part')); } catch {}
      }
      if (id === 'argos') {
        const staging = path.resolve(this.library, 'argos', 'models.incoming');
        if (path.dirname(staging) === path.resolve(this.library, 'argos')) {
          try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
        }
        for (const p of this.argosSpec.packages) {
          try { fs.rmSync(path.join(this.library, 'cache', 'argos', p.filename + '.part')); } catch {}
        }
      }
      this.activeJob = null;
    }
  }

  cancel() { return this.installer.stop(); }
  async clearCache(id) {
    for (const file of this.filesFor(id)) for (const suffix of ['', '.part', '.part.json']) await fs.promises.rm(file.target + suffix, { force: true });
  }
  async uninstall(id) {
    if (this.activeJob) throw new Error('请先暂停下载或安装。');
    const ids = id === 'multi-dictionaries' ? this.catalog.dictionaries.map(item => item.id) : [id];
    this.filesFor(id);
    await this.installer.stop();
    for (const resourceId of ids) {
      const folder = path.resolve(this.library, resourceId);
      if (path.dirname(folder) !== path.resolve(this.library)) throw new Error('资源路径无效。');
      const modelDirectory = resourceId === 'kokoro' ? 'model' : resourceId === 'argos' ? 'models' : null;
      if (modelDirectory) {
        const target = path.resolve(folder, modelDirectory);
        if (path.dirname(target) !== folder) throw new Error('资源路径无效。');
        await fs.promises.rm(target, { recursive: true, force: true });
      }
      for (const filename of ['metadata.json', 'ATTRIBUTION.txt', ...(resourceId === 'hy-mt2' ? [this.hySpec.filename] : ['dictionary.db'])]) {
        await fs.promises.rm(path.join(folder, filename), { force: true });
      }
    }
    await this.clearCache(id);
  }
}

function resolveSources(files, sources, options = {}) {
  const source = options.source || 'auto';
  if (source === 'custom') {
    if (!Array.isArray(options.urls) || options.urls.length !== files.length) throw new Error('请为每个文件填写下载地址。');
    for (const text of options.urls) {
      let url;
      try { url = new URL(text); } catch { throw new Error('下载地址无效。'); }
      if (url.protocol !== 'https:' || url.username || url.password || text.length > 2048) throw new Error('请使用不包含账户信息的 HTTPS 下载地址。');
    }
    return options.urls.map(url => [url]);
  }
  const selected = source === 'auto' ? sources : sources.filter(item => item.id === source);
  if (!selected.length) throw new Error('下载来源无效。');
  return files.map((_, index) => selected.map(item => item.urls[index]));
}
module.exports = { ResourceManager, resolveSources };
