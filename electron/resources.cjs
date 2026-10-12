const fs = require('node:fs');
const path = require('node:path');
const { WorkerClient } = require('./worker.cjs');

class ResourceManager {
  constructor({ assets, library, python, script, progress }) {
    this.assets = assets;
    this.library = library;
    this.catalog = JSON.parse(fs.readFileSync(path.join(assets, 'dictionaries.json'), 'utf8'));
    this.hySpec = JSON.parse(fs.readFileSync(path.join(assets, 'hy-model.json'), 'utf8'));
    this.argosSpec = JSON.parse(fs.readFileSync(path.join(assets, 'argos-model.json'), 'utf8'));
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

  modelFile() { return path.join(this.library, 'hy-mt1.5', this.hySpec.filename); }

  downloadLinks(id) {
    if (id === 'argos') return this.argosSpec.packages.map(p => p.url);
    if (id === 'hy-mt1.5') return [this.hySpec.url];
    throw new Error('资源无效。');
  }

  argosRoot() { return path.join(this.library, 'argos'); }

  argosStatus() {
    const meta = this.metadata('argos');
    const ready = this.argosSpec.packages.every(p => meta?.packages?.[p.pair] === p.sha256 &&
      ['model/model.bin', 'model/config.json', 'sentencepiece.model'].every(file => {
        try { return fs.statSync(path.join(this.argosRoot(), 'models', p.pair, file)).size > 0; } catch { return false; }
      }));
    return { ...this.argosSpec, ready };
  }

  hyStatus() {
    const meta = this.metadata('hy-mt1.5');
    let size = 0;
    try { size = fs.statSync(this.modelFile()).size; } catch {}
    return { ready: meta?.sha256 === this.hySpec.sha256 && size === this.hySpec.bytes, ...this.hySpec };
  }

  async install(id, sourceFile) {
    if (this.activeJob) throw new Error('已有资源正在安装，请等待完成或取消。');
    if (!['argos', 'hy-mt1.5'].includes(id) && !this.catalog.dictionaries.some(item => item.id === id)) throw new Error('资源无效。');
    if (id === 'argos' && this.argosStatus().ready) throw new Error('Argos 模型已经安装。');
    if (!['argos', 'hy-mt1.5'].includes(id) && this.list().find(item => item.id === id)?.installed) throw new Error('这个词库已经安装。');
    this.activeJob = id;
    this.progress({ id, phase: 'starting', message: '正在准备资源…' });
    try {
      return await this.installer.request('install', { resourceId: id, library: this.library, sourceFile }, { timeout: 30 * 60_000 });
    } catch (error) {
      this.progress({ id, phase: error.message.includes('取消') ? 'cancelled' : 'error', message: error.message });
      throw error;
    } finally {
      await this.installer.stop();
      // Hard cancellation does not run Python finally blocks. Clean only known staging files.
      for (const staging of ['dictionary.db.building', this.hySpec.filename + '.incoming', this.hySpec.filename + '.incoming.part']) {
        try { fs.rmSync(path.join(this.library, id, staging)); } catch {}
      }
      try { fs.rmSync(path.join(this.library, 'cache', 'wiktionary-zh.jsonl.gz.part')); } catch {}
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
}

module.exports = { ResourceManager };
