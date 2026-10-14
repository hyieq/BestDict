const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');

class WorkerClient {
  constructor(python, script, assets, kind, { idleTimeout = 60_000 } = {}) {
    this.config = { python, script, assets, kind };
    this.pending = new Map();
    this.nextId = 0;
    this.process = null;
    this.idleTimer = null;
    this.idleTimeout = idleTimeout;
    this.keepAlive = false;
    this.stopping = Promise.resolve();
  }

  start() {
    if (this.process) return;
    const { python, script, assets, kind } = this.config;
    const child = spawn(python, ['-u', script, '--assets', assets, '--kind', kind], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONUTF8: '1' },
    });
    this.process = child;
    let diagnostics = '';
    child.stderr.on('data', data => { diagnostics = (diagnostics + data).slice(-2000); });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      if (this.process !== child) return;
      let response;
      try { response = JSON.parse(line); } catch { return; }
      if (response.event === 'progress') { this.onProgress?.(response.data); return; }
      const task = this.pending.get(response.id);
      if (!task) return;
      if (response.event === 'audio') {
        if (task.onEvent) task.refresh();
        try { task.onEvent?.(response.data); } catch (error) { this.stop(error); }
        return;
      }
      clearTimeout(task.timer);
      this.pending.delete(response.id);
      if (response.error) task.reject(new Error(response.error));
      else task.resolve(response.result);
      this.armIdle();
    });
    const fail = error => {
      if (this.process !== child) return;
      this.process = null;
      for (const task of this.pending.values()) { clearTimeout(task.timer); task.reject(error); }
      this.pending.clear();
    };
    child.on('error', error => fail(new Error(`离线服务无法启动：${error.message}`)));
    child.on('exit', code => fail(new Error(`离线服务已退出 (${code})。${diagnostics}`)));
    child.stdin.on('error', error => fail(error));
  }

  armIdle() {
    clearTimeout(this.idleTimer);
    if (this.process && !this.keepAlive && ['translation', 'speech', 'ocr'].includes(this.config.kind) && !this.pending.size) {
      this.idleTimer = setTimeout(() => this.stop(), this.idleTimeout);
      this.idleTimer.unref();
    }
  }

  request(method, params = {}, { signal, timeout = 90_000, onEvent } = {}) {
    if (signal?.aborted) return Promise.reject(new Error('请求已取消'));
    clearTimeout(this.idleTimer);
    this.start();
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const task = { resolve, reject, timer: null, method, onEvent, refresh: () => {
        clearTimeout(task.timer);
        task.timer = setTimeout(() => this.stop(new Error('离线处理超时，请缩短文本后重试。')), timeout);
      } };
      task.refresh();
      this.pending.set(id, task);
      this.process.stdin.write(JSON.stringify({ id, method, ...params }) + '\n');
    });
  }

  stop(error = new Error('离线请求已取消')) {
    clearTimeout(this.idleTimer);
    const child = this.process;
    this.process = null;
    if (child) {
      this.stopping = new Promise(resolve => {
        let timer;
        const done = () => { clearTimeout(timer); resolve(); };
        child.once('exit', done);
        child.once('error', done);
        timer = setTimeout(done, 2000);
        timer.unref();
        if (child.exitCode !== null || child.signalCode !== null || !child.kill()) done();
      });
    }
    for (const task of this.pending.values()) { clearTimeout(task.timer); task.reject(error); }
    this.pending.clear();
    return this.stopping;
  }
}

module.exports = { WorkerClient };
