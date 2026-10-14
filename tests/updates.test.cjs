const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { UpdateService, newerVersion } = require('../electron/updates.cjs');

const release = (version = '0.4.10', names = [`BestDict-${version}-x64-Setup.exe`]) => ({
  tag_name: `v${version}`, draft: false, prerelease: false,
  assets: names.map(name => ({ name, size: 1234, state: 'uploaded', browser_download_url: 'https://untrusted.example/package.exe' })),
});
const response = data => new Response(JSON.stringify(data));
const service = options => new UpdateService({ version: '0.4.9', platform: 'win32', arch: 'x64', openExternal: async () => {}, ...options });

test('update versions compare numerically and reject malformed or prerelease tags', () => {
  for (const [next, current] of [['0.4.10', '0.4.9'], ['1.0.0', '0.99.99'], ['0.5.0', '0.4.99']]) assert.equal(newerVersion(next, current), true);
  for (const [next, current] of [['0.4.9', '0.4.10'], ['0.4.10', '0.4.10']]) assert.equal(newerVersion(next, current), false);
  for (const invalid of ['v0.4.10-beta', 'v01.4.10', 'main', null]) assert.throws(() => newerVersion(invalid, '0.4.9'), /更新信息无效/);
});

test('checks are manual, share concurrent requests, cache briefly and refresh after expiration', async () => {
  let calls = 0, finish, now = 0;
  const updates = service({ now: () => now, fetchRelease: (url, options) => {
    calls++;
    assert.equal(url, 'https://api.github.com/repos/hyieq/BestDict/releases/latest');
    assert.equal(options.headers.Authorization, undefined);
    return new Promise(resolve => { finish = resolve; });
  } });
  assert.equal(calls, 0);
  const first = updates.check(), duplicate = updates.check();
  assert.equal(first, duplicate);
  finish(response(release()));
  assert.equal((await first).state, 'available');
  assert.equal((await updates.check()).latestVersion, '0.4.10');
  assert.equal(calls, 1);
  now = 300001;
  const fresh = updates.check();
  finish(response(release('0.4.11')));
  assert.equal((await fresh).latestVersion, '0.4.11');
  assert.equal(calls, 2);
});

test('download links select the correct architecture and stay in the fixed repository', async () => {
  for (const [platform, arch, names, selected] of [
    ['win32', 'x64', ['BestDict-0.4.10-x64-Setup.exe', 'BestDict-0.4.10-macOS-arm64.dmg'], 'BestDict-0.4.10-x64-Setup.exe'],
    ['darwin', 'arm64', ['BestDict-0.4.10-x64-Setup.exe', 'BestDict-0.4.10-macOS-arm64.zip', 'BestDict-0.4.10-macOS-arm64.dmg'], 'BestDict-0.4.10-macOS-arm64.dmg'],
    ['darwin', 'arm64', ['BestDict-0.4.10-macOS-arm64.zip'], 'BestDict-0.4.10-macOS-arm64.zip'],
    ['darwin', 'x64', ['BestDict-0.4.10-macOS-arm64.dmg', 'BestDict-0.4.10-macOS-x64.dmg'], 'BestDict-0.4.10-macOS-x64.dmg'],
    ['darwin', 'x64', ['BestDict-0.4.10-macOS-x64.zip'], 'BestDict-0.4.10-macOS-x64.zip'],
  ]) {
    const opened = [];
    const updates = service({ platform, arch, fetchRelease: async () => response(release('0.4.10', names)), openExternal: async url => opened.push(url) });
    assert.throws(() => updates.open('download'), /没有适用于/);
    assert.equal((await updates.check()).state, 'available');
    await updates.open('download'); await updates.open('release');
    assert.deepEqual(opened, [`https://github.com/hyieq/BestDict/releases/download/v0.4.10/${selected}`, 'https://github.com/hyieq/BestDict/releases/tag/v0.4.10']);
    assert.throws(() => updates.open('https://untrusted.example'), /没有适用于/);
  }
});

test('missing, incomplete or incompatible assets never offer the wrong installer or report latest', async () => {
  for (const data of [release('0.4.10', []), release('0.4.10', ['BestDict-0.4.10-macOS-arm64.dmg']),
    { ...release(), assets: [{ name: 'BestDict-0.4.10-x64-Setup.exe', size: 0, state: 'uploaded' }] }]) {
    const updates = service({ fetchRelease: async () => response(data) });
    assert.equal((await updates.check()).state, 'unavailable');
    assert.throws(() => updates.open('download'), /没有适用于/);
  }
  const updates = service({ fetchRelease: async () => response(release('0.4.8')) });
  assert.equal((await updates.check()).state, 'latest');
  assert.throws(() => updates.open('download'), /没有适用于/);
});

test('stable release checks handle missing releases, HTTP errors and invalid data without caching failures', async () => {
  const updates = service({ fetchRelease: async () => new Response('', { status: 404 }) });
  assert.equal((await updates.check()).state, 'unpublished');
  for (const [fetchRelease, message] of [
    [async () => new Response('', { status: 403 }), /限制了检查请求/],
    [async () => new Response('', { status: 429 }), /限制了检查请求/],
    [async () => new Response('', { status: 500 }), /无法连接 GitHub/],
    [async () => new Response('not json'), /更新信息无效/],
    [async () => response({ ...release(), draft: true }), /更新信息无效/],
    [async () => response({ ...release(), prerelease: true }), /更新信息无效/],
    [async () => response(null), /更新信息无效/],
    [async () => { throw new TypeError('offline'); }, /检查网络/],
  ]) {
    const checker = service({ fetchRelease });
    await assert.rejects(checker.check(), message);
    checker.fetchRelease = async () => response(release());
    assert.equal((await checker.check()).state, 'available', 'A manual retry can recover immediately.');
  }
});

test('a stalled network request times out and preserves the release-page fallback', async t => {
  const server = createServer(() => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const opened = [];
  const updates = service({ timeout: 40, fetchRelease: (_url, options) => fetch(`http://127.0.0.1:${server.address().port}`, options), openExternal: async url => opened.push(url) });
  await assert.rejects(updates.check(), /检查更新超时/);
  await updates.open('release');
  assert.deepEqual(opened, ['https://github.com/hyieq/BestDict/releases/latest']);
});
