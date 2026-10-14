const fs = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');

async function digest(filename) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
function readJSON(filename) { try { return JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { return null; } }
function partialBytes(target) { try { return fs.statSync(target + '.part').size; } catch { return 0; } }

// Keep incomplete bytes on interruption. Immutable models use their manifest hash;
// mutable dictionary data resumes only against the same URL and a server validator.
async function downloadFile({ urls, target, bytes = 0, sha256, signal, onProgress = () => {}, stallMs = 30000 }) {
  signal?.throwIfAborted();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const partial = target + '.part', metadata = partial + '.json';
  const identity = sha256 || 'mutable';
  const reset = async () => {
    await fs.promises.rm(partial, { force: true });
    await fs.promises.rm(metadata, { force: true });
  };
  if (fs.existsSync(target) && (!bytes || fs.statSync(target).size === bytes) &&
      (!sha256 || await digest(target) === sha256)) {
    signal?.throwIfAborted();
    onProgress({ received: fs.statSync(target).size, total: bytes || fs.statSync(target).size, cached: true });
    return target;
  }
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const url of [...new Set(urls)]) {
      signal?.throwIfAborted();
      const controller = new AbortController();
      let timer;
      const refresh = () => {
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(new Error('下载连接超时。')), stallMs);
        timer.unref();
      };
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      try {
        let saved = readJSON(metadata), offset = partialBytes(target);
        if (saved?.identity !== identity || (!sha256 && (saved?.url !== url || !saved?.validator))) {
          await reset(); saved = null; offset = 0;
        }
        const headers = { 'User-Agent': 'BestDict resource download', 'Accept-Encoding': 'identity' };
        if (offset) {
          headers.Range = 'bytes=' + offset + '-';
          if (saved?.url === url && saved.validator) headers['If-Range'] = saved.validator;
        }
        refresh();
        const response = await fetch(url, { headers, signal: combined });
        if (response.status === 416) { await response.body?.cancel(); await reset(); throw new Error('下载断点已失效，正在重新下载。'); }
        if (!response.ok || !response.body) throw new Error('下载来源暂不可用 (' + response.status + ')。');
        let total = Number(response.headers.get('content-length')) || bytes;
        if (response.status === 206) {
          const range = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
          if (!range || Number(range[1]) !== offset || Number(range[2]) < offset || (bytes && sha256 && Number(range[3]) !== bytes)) {
            await response.body.cancel(); await reset(); throw new Error('下载断点不匹配。');
          }
          total = Number(range[3]);
        } else if (offset) {
          offset = 0;
          onProgress({ received: 0, total, restarted: true });
        }
        const validator = response.headers.get('etag') || response.headers.get('last-modified');
        fs.writeFileSync(metadata, JSON.stringify({ identity, url, validator }));
        let received = offset, lastProgress = 0;
        const output = await fs.promises.open(partial, offset ? 'a' : 'w');
        onProgress({ received, total, url, resumed: offset > 0 });
        try {
          for await (const chunk of response.body) {
            combined.throwIfAborted();
            received += chunk.length;
            if (received > (sha256 && bytes ? bytes : 2 * 1024 ** 3)) throw new Error('下载文件超过预期大小。');
            await output.writeFile(chunk);
            refresh();
            if (Date.now() - lastProgress >= 200) { onProgress({ received, total, url }); lastProgress = Date.now(); }
          }
        } finally { await output.close(); }
        if ((total && received !== total) || (sha256 && bytes && received !== bytes)) throw new Error('下载不完整，请重试。');
        onProgress({ received, total: received, verifying: true });
        if (sha256 && await digest(partial) !== sha256) {
          await reset(); throw new Error('模型校验失败，请重试。');
        }
        combined.throwIfAborted();
        await fs.promises.rename(partial, target);
        await fs.promises.rm(metadata, { force: true });
        return target;
      } catch (error) {
        if (signal?.aborted) throw error;
        lastError = error;
        onProgress({ retrying: true, message: error.message });
      } finally { clearTimeout(timer); }
    }
  }
  throw lastError || new Error('没有可用的下载来源。');
}
module.exports = { downloadFile, partialBytes, digest };
