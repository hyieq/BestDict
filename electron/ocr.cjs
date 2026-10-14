const fs = require('node:fs');
const path = require('node:path');
const { WorkerClient } = require('./worker.cjs');
const { downloadFile, digest, partialBytes } = require('./download-file.cjs');
const { resolveSources } = require('./resources.cjs');

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
  filesFor() { return this.spec.files.map(file => ({ ...file, filename: file.name, target: path.join(this.directory, file.name) })); }
  sourcesFor() {
    const sources = [{ id: 'official', name: 'ModelScope 官方来源', urls: this.spec.files.map(file => file.url) }];
    if (this.spec.files.every(file => file.name.startsWith('PP-OCRv6_'))) {
      sources.push({ id: 'huggingface', name: 'Hugging Face 社区镜像', urls: this.spec.files.map(file =>
        'https://huggingface.co/DjB314/RapidOCR/resolve/04e88d0483f0bfcdd0f29429594244c10bfc2867/v3.9.2/onnx/PP-OCRv6/' +
        (file.name.includes('_det_') ? 'det/' : 'rec/') + file.name) });
    }
    return sources;
  }
  pendingBytes() { return this.filesFor().reduce((n, f) => n + partialBytes(f.target), 0); }
  async install(options = {}, { signal, onProgress = () => {} } = {}) {
    if (this.controller) throw new Error('OCR 模型正在下载。');
    const urls = resolveSources(this.filesFor(), this.sourcesFor(), options);
    const controller = new AbortController();
    this.controller = controller;
    this.progress = { received: 0, total: this.status().bytes };
    let completed = 0;
    try {
      for (const [index, file] of this.spec.files.entries()) {
        const target = path.join(this.directory, file.name);
        await downloadFile({ urls: urls[index], target, bytes: file.bytes, sha256: file.sha256,
          signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
          onProgress: event => {
            if (event.received !== undefined) this.progress.received = completed + event.received;
            onProgress({ id: 'ocr', phase: event.verifying ? 'verifying' : 'downloading',
              ...this.progress, message: event.verifying ? '正在验证文件…' : event.retrying ? '正在重试或切换来源…' : '正在下载…' });
          } });
        completed += file.bytes;
      }
      return this.status();
    } finally {
      this.controller = null;
      this.progress = null;
    }
  }
  cancelDownload() { this.controller?.abort(); }
  async import(files) {
    if (this.controller) throw new Error('OCR 模型正在下载。');
    if (!Array.isArray(files) || files.length !== this.spec.files.length) throw new Error('请选择两个 OCR 模型文件。');
    const matches = [];
    for (const source of files) matches.push({ source, sha256: await digest(source), bytes: fs.statSync(source).size });
    const inputs = this.spec.files.map(file => matches.find(item => item.sha256 === file.sha256 && item.bytes === file.bytes));
    if (inputs.some(item => !item)) throw new Error('OCR 模型校验失败，请重试。');
    await this.worker.stop(); fs.mkdirSync(this.directory, { recursive: true });
    for (const [index, file] of this.spec.files.entries()) {
      const target = path.join(this.directory, file.name);
      await fs.promises.copyFile(inputs[index].source, target + '.incoming');
      await fs.promises.rename(target + '.incoming', target);
    }
    return this.status();
  }
  async uninstall() {
    if (this.controller) throw new Error('请先取消 OCR 下载。');
    await this.worker.stop();
    // Remove only the manifest's known files, never a user-selected directory.
    for (const file of this.spec.files) for (const suffix of ['', '.part', '.part.json']) await fs.promises.rm(path.join(this.directory, file.name + suffix), { force: true });
    return this.status();
  }
  recognize(image) {
    if (!this.status().ready) throw new Error('请先在设置 → 模型与词库中下载 OCR 模型。');
    return this.worker.request('recognize', { image, files: this.spec.files }, { timeout: 90000 });
  }
  stop() { this.cancelDownload(); this.worker.stop(); }
}
module.exports = { OCRService };
