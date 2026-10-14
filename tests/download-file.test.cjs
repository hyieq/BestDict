const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createServer } = require('node:http');
const { downloadFile } = require('../electron/download-file.cjs');

const body = Buffer.alloc(65536, 37), sha256 = createHash('sha256').update(body).digest('hex');
async function fixture(t, handler) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bestdict-download-'));
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('bestdict-download-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { target: path.join(directory, 'model'), url: 'http://127.0.0.1:' + server.address().port };
}
for (const ignoresRange of [false, true]) test('cancelled bytes survive and a later request ' + (ignoresRange ? 'restarts safely when Range is ignored' : 'resumes with exact Range'), async t => {
  let calls = 0, range;
  const { target, url } = await fixture(t, (req, res) => {
    calls++; res.setHeader('ETag', '"fixed"');
    if (calls === 1) { res.setHeader('Content-Length', body.length); res.write(body.subarray(0, 16384)); return; }
    range = req.headers.range;
    const start = ignoresRange ? 0 : Number(range?.match(/\d+/)[0] || 0);
    if (start) { res.statusCode = 206; res.setHeader('Content-Range', 'bytes ' + start + '-' + (body.length - 1) + '/' + body.length); }
    res.end(body.subarray(start));
  });
  const controller = new AbortController();
  const running = downloadFile({ urls: [url], target, bytes: body.length, sha256, signal: controller.signal,
    onProgress: event => { if (event.received >= 16384) controller.abort(); } });
  await assert.rejects(running);
  const offset = fs.statSync(target + '.part').size;
  assert.equal(offset, 16384);
  const events = [];
  await downloadFile({ urls: [url], target, bytes: body.length, sha256, onProgress: event => events.push(event) });
  assert.equal(range, 'bytes=' + offset + '-');
  assert.deepEqual(fs.readFileSync(target), body);
  assert.equal(fs.existsSync(target + '.part'), false);
  assert.ok(events.some(event => ignoresRange ? event.restarted : event.resumed));
});
test('bad hashes and unavailable sources fail over without accepting corrupt weights', async t => {
  const { target, url } = await fixture(t, (req, res) => {
    if (req.url === '/offline') { res.statusCode = 503; return res.end(); }
    res.end(req.url === '/bad' ? Buffer.alloc(body.length, 42) : body);
  });
  await downloadFile({ urls: [url + '/offline', url + '/bad', url + '/good'], target, bytes: body.length, sha256 });
  assert.deepEqual(fs.readFileSync(target), body);
});
test('mutable dictionary bytes cannot be spliced across different URLs', async t => {
  let sawRange = false;
  const { target, url } = await fixture(t, (req, res) => {
    res.setHeader('ETag', '"v1"');
    if (req.url === '/first') { res.setHeader('Content-Length', body.length); res.write(body.subarray(0, 16384)); return; }
    sawRange = !!req.headers.range; res.end(body);
  });
  const controller = new AbortController();
  await assert.rejects(downloadFile({ urls: [url + '/first'], target, signal: controller.signal,
    onProgress: event => { if (event.received >= 16384) controller.abort(); } }));
  await downloadFile({ urls: [url + '/second'], target });
  assert.equal(sawRange, false); assert.deepEqual(fs.readFileSync(target), body);
});
test('malformed Content-Range is rejected and incomplete progress does not become a final file', async t => {
  const { target, url } = await fixture(t, (_req, res) => {
    res.statusCode = 206; res.setHeader('Content-Range', 'bytes 5-10/65536'); res.end(body);
  });
  await assert.rejects(downloadFile({ urls: [url], target, bytes: body.length, sha256 }), /断点/);
  assert.equal(fs.existsSync(target), false);
});
test('stalled transfers time out even when the connection remains open', async t => {
  const { target, url } = await fixture(t, (_req, res) => { res.writeHead(200); res.flushHeaders(); });
  await assert.rejects(downloadFile({ urls: [url], target, bytes: body.length, sha256, stallMs: 60 }), /超时|abort/i);
  assert.equal(fs.existsSync(target), false);
});
