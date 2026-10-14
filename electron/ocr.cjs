const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { WorkerClient } = require('./worker.cjs');

class OCRService {
  constructor({ python, backend, assets, library }) {
    this.spec = JSON.parse(fs.readFileSync(path.join(assets, 'ocr-model.json'), 'utf8'));
    this.directory = path.join(library, 'ocr');
    this.worker = new WorkerClient(python, path.join(backend, 'ocr_worker.py'), this.directory, 'ocr');
    this.progress = null;
    this.controller = null;
  }
  status() {
    const ready = this.spec.files.every(file => {
      try { return fs.statSync(path.join(this.directory, file.name)).size === file.bytes; } catch { return false; }
    });
    return { ready, supported: process.platform === 'win32', bytes: this.spec.files.reduce((n, f) => n + f.bytes, 0), progress: this.progress };
  }
  async install() {
    if (this.controller) throw new Error('OCR 模型正在下载。');
    const controller = new AbortController();
    this.controller = controller;
    this.progress = { received: 0, total: this.status().bytes };
    fs.mkdirSync(this.directory, { recursive: true });
    try {
      for (const file of this.spec.files) {
        const target = path.join(this.directory, file.name);
        const response = await fetch(file.url, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(300000)]) });
        if (!response.ok || !response.body) throw new Error(`OCR 下载失败 (${response.status})`);
        const hash = createHash('sha256');
        let size = 0;
        const output = await fs.promises.open(target + '.part', 'w');
        try {
          for await (const chunk of response.body) {
            size += chunk.length;
            if (size > file.bytes) throw new Error('OCR 模型大小不符。');
            hash.update(chunk);
            await output.writeFile(chunk);
            this.progress.received += chunk.length;
          }
        } finally { await output.close(); }
        if (size !== file.bytes || hash.digest('hex') !== file.sha256) throw new Error('OCR 模型校验失败，请重试。');
        controller.signal.throwIfAborted();
        await fs.promises.rename(target + '.part', target);
      }
      return this.status();
    } finally {
      for (const file of this.spec.files) await fs.promises.rm(path.join(this.directory, file.name + '.part'), { force: true }).catch(() => {});
      this.controller = null;
      this.progress = null;
    }
  }
  cancelDownload() { this.controller?.abort(); }
  async uninstall() {
    if (this.controller) throw new Error('请先取消 OCR 下载。');
    await this.worker.stop();
    // Remove only the manifest's known files, never a user-selected directory.
    for (const file of this.spec.files) await fs.promises.rm(path.join(this.directory, file.name), { force: true });
    return this.status();
  }
  recognize(image) {
    if (!this.status().ready) throw new Error('请先在设置 → 截图翻译中下载 OCR 模型。');
    return this.worker.request('recognize', { image, files: this.spec.files }, { timeout: 90000 });
  }
  stop() { this.cancelDownload(); this.worker.stop(); }
}
module.exports = { OCRService };
