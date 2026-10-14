const fs = require('node:fs');
const path = require('node:path');

class ResourceQueue {
  constructor({ library, run, cancel, known, progress = () => {} }) {
    this.file = path.join(library, 'download-jobs.json');
    this.run = run; this.cancelRun = cancel; this.known = known; this.progress = progress;
    this.jobs = {}; this.active = null; this.closed = false;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [id, job] of Object.entries(saved)) {
        if (known(id)) this.jobs[id] = { ...job, id, state: ['running', 'queued'].includes(job.state) ? 'paused' : job.state };
      }
    } catch {}
  }
  snapshot() { return Object.values(this.jobs).map(({ controller, ...job }) => ({ ...job })); }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const staging = this.file + '.incoming';
    fs.writeFileSync(staging, JSON.stringify(this.jobs));
    fs.renameSync(staging, this.file);
    this.progress(this.snapshot());
  }
  enqueue(ids, options = {}) {
    if (!Array.isArray(ids) || ids.length > 5 || !ids.length || ids.some(id => !this.known(id))) throw new Error('下载资源无效。');
    for (const id of ids) {
      if (['running', 'queued'].includes(this.jobs[id]?.state)) continue;
      this.jobs[id] = { id, state: 'queued', options: options[id] || this.jobs[id]?.options || {}, received: this.jobs[id]?.received || 0 };
    }
    this.save(); void this.drain();
    return this.snapshot();
  }
  update(event) {
    const job = this.jobs[this.active];
    if (!job || event.id !== job.id) return;
    Object.assign(job, { phase: event.phase, message: event.message,
      ...(event.received !== undefined ? { received: event.received } : {}),
      ...(event.total !== undefined ? { total: event.total } : {}) });
    this.progress(this.snapshot());
  }
  async pause(id) {
    if (!this.known(id)) throw new Error('下载资源无效。');
    const job = this.jobs[id];
    if (!job || !['queued', 'running'].includes(job.state)) return;
    job.state = 'paused';
    try { this.save(); }
    finally { if (this.active === id) { this.controller.abort(); await this.cancelRun(id); } }
  }
  async drain() {
    if (this.active || this.closed) return;
    const job = Object.values(this.jobs).find(item => item.state === 'queued');
    if (!job) return;
    this.active = job.id; job.state = 'running'; this.controller = new AbortController();
    try {
      this.save();
      await this.run(job.id, job.options, this.controller.signal);
      if (job.state === 'running') job.state = 'complete';
    } catch (error) {
      if (job.state === 'running') { job.state = 'error'; job.message = error.message; }
    } finally {
      this.active = null;
      try { this.save(); } catch (error) { job.message = error.message; this.progress(this.snapshot()); }
      void this.drain();
    }
  }
  stop() {
    this.closed = true;
    for (const job of Object.values(this.jobs)) if (['queued', 'running'].includes(job.state)) job.state = 'paused';
    try { this.save(); } catch (error) { console.error('Download state could not be saved:', error.message); }
    this.controller?.abort();
    if (this.active) void this.cancelRun(this.active);
  }
}
module.exports = { ResourceQueue };
