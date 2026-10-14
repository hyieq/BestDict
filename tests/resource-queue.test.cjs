const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { ResourceQueue } = require('../electron/resource-queue.cjs');
const { resolveSources } = require('../electron/resources.cjs');
const { setTimeout: delay } = require('node:timers/promises');
async function until(check) { for (let i = 0; i < 200; i++) { if (check()) return; await delay(5); } assert.fail('Queue did not settle'); }
test('source selection preserves file order and rejects malformed or credential-bearing custom URLs', () => {
  const files = [{}, {}], sources = [{ id: 'official', urls: ['https://one/a', 'https://one/b'] }, { id: 'backup', urls: ['https://two/a', 'https://two/b'] }];
  assert.deepEqual(resolveSources(files, sources, {}), [['https://one/a', 'https://two/a'], ['https://one/b', 'https://two/b']]);
  assert.deepEqual(resolveSources(files, sources, { source: 'backup' }), [['https://two/a'], ['https://two/b']]);
  assert.throws(() => resolveSources(files, sources, { source: 'unknown' }), /无效/);
  assert.throws(() => resolveSources(files, sources, { source: 'custom', urls: ['https://one/a'] }), /每个文件/);
  for (const url of ['http://one/a', 'https://user:password@one/a', 'file:///a', 'invalid']) {
    assert.throws(() => resolveSources(files, sources, { source: 'custom', urls: [url, 'https://one/b'] }), /无效|HTTPS/);
  }
});
test('queue deduplicates, pauses, continues other jobs and restores interrupted work without starting downloads', async t => {
  const library = fs.mkdtempSync(path.join(os.tmpdir(), 'bestdict-queue-'));
  const calls = [];
  const queue = new ResourceQueue({ library, known: id => ['a', 'b', 'c'].includes(id), cancel: async () => {},
    run: async (id, _options, signal) => {
      calls.push(id);
      if (id === 'a') await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      if (id === 'b') throw new Error('fixture failure');
    } });
  t.after(() => { queue.stop(); assert.equal(path.dirname(library), path.resolve(os.tmpdir())); fs.rmSync(library, { recursive: true, force: true }); });
  queue.enqueue(['a', 'b', 'c']); queue.enqueue(['a']);
  await until(() => queue.active === 'a');
  queue.update({ id: 'a', phase: 'downloading', received: 200, total: 1000, message: 'fixture' });
  await queue.pause('a');
  await until(() => queue.jobs.c.state === 'complete');
  assert.deepEqual(calls, ['a', 'b', 'c']);
  assert.equal(queue.jobs.a.state, 'paused'); assert.equal(queue.jobs.b.state, 'error');
  const restored = new ResourceQueue({ library, known: id => ['a', 'b', 'c'].includes(id), run: () => assert.fail('Must wait for user'), cancel: async () => {} });
  assert.equal(restored.jobs.a.received, 200); assert.equal(restored.active, null);
  assert.throws(() => queue.enqueue(['invalid']), /无效/);
});
