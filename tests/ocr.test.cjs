const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createServer } = require('node:http');
const { createHash } = require('node:crypto');
const { OCRService } = require('../electron/ocr.cjs');

async function fixture(t, handler, expected = Buffer.from('verified model')) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bestdict-ocr-test-'));
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const file = { name: 'fixture.onnx', bytes: expected.length, sha256: createHash('sha256').update(expected).digest('hex'), url: `http://127.0.0.1:${server.address().port}/model` };
  fs.writeFileSync(path.join(directory, 'ocr-model.json'), JSON.stringify({ files: [file] }));
  const service = new OCRService({ python: 'unused', backend: directory, assets: directory, library: directory });
  t.after(async () => {
    service.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    // This is the freshly allocated test directory only.
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { service, file, directory };
}
test('OCR download commits verified bytes, reports readiness and removes only model files', async t => {
  const { service, file } = await fixture(t, (_req, res) => res.end('verified model'));
  assert.equal(service.status().ready, false);
  await service.install();
  assert.equal(service.status().ready, true);
  assert.equal(service.status().progress, null);
  fs.writeFileSync(path.join(service.directory, 'keep.txt'), 'keep');
  await service.uninstall();
  assert.equal(service.status().ready, false);
  assert.equal(fs.existsSync(path.join(service.directory, file.name)), false);
  assert.equal(fs.readFileSync(path.join(service.directory, 'keep.txt'), 'utf8'), 'keep');
});
test('hash mismatch leaves no ready model or staging files', async t => {
  const { service } = await fixture(t, (_req, res) => res.end('modified model'));
  await assert.rejects(service.install(), /校验失败/);
  assert.equal(service.status().ready, false);
  assert.deepEqual(fs.readdirSync(service.directory), []);
});
test('cancel streaming download releases lock and permits retry', async t => {
  let first = true;
  let started;
  const ready = new Promise(resolve => started = resolve);
  const { service } = await fixture(t, (_req, res) => {
    if (!first) return res.end('verified model');
    first = false; res.write('ver'); started();
  });
  const running = service.install();
  const rejected = assert.rejects(running);
  await ready;
  await assert.rejects(service.install(), /正在下载/);
  await assert.rejects(service.uninstall(), /取消/);
  service.cancelDownload();
  await rejected;
  assert.deepEqual(fs.readdirSync(service.directory), []);
  assert.equal(service.status().progress, null);
  await service.install();
  assert.equal(service.status().ready, true);
});
