const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, writeFile, readFile, rm } = require('node:fs/promises');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bestdict-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const version = require('../package.json').version;
  const names = [`BestDict-${version}-x64-Setup.exe`, `BestDict-${version}-macOS-x64.dmg`, `BestDict-${version}-macOS-arm64.dmg`];
  for (const name of names) {
    const bytes = Buffer.from(`installer fixture ${name}`);
    await writeFile(path.join(directory, name), bytes);
    await writeFile(path.join(directory, `${name}.sha256`), `${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`);
  }
  const { verifyReleaseAssets } = await import('../scripts/prepare_release.mjs');
  return { directory, version, names, verify: () => verifyReleaseAssets(directory, version) };
}

test('release requires all three installers and matching checksums', async t => {
  const f = await fixture(t);
  assert.equal((await f.verify()).length, 6);
  await rm(path.join(f.directory, f.names[1]));
  await assert.rejects(f.verify(), /ENOENT/);
});
test('release refuses a corrupted binary or checksum for another architecture', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, f.names[0]), 'corrupted');
  await assert.rejects(f.verify(), /Checksum mismatch/);
  await writeFile(path.join(f.directory, `${f.names[0]}.sha256`), `${'0'.repeat(64)}  ${f.names[2]}\n`);
  await assert.rejects(f.verify(), /Invalid checksum/);
});
test('release refuses unexpected installers and other versions', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, 'BestDict-0.4.16-macOS-x64.dmg'), 'old');
  await assert.rejects(f.verify(), /Unexpected release asset/);
});
test('release notes cover all platforms and contain the current changelog', async t => {
  const f = await fixture(t);
  execFileSync(process.execPath, ['scripts/prepare_release.mjs', f.directory], {
    cwd: path.resolve(__dirname, '..'), env: { ...process.env, RELEASE_TAG: `v${f.version}` },
  });
  const notes = await readFile(path.join(f.directory, 'release-notes.md'), 'utf8');
  assert.ok(notes.includes(`BestDict ${f.version}`));
  assert.ok(notes.includes('macOS-x64.dmg') && notes.includes('macOS-arm64.dmg') && notes.includes('Setup.exe'));
  assert.match(notes, /## 更新内容\n\n- /);
});
