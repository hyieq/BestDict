const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gzipSync } = require('node:zlib');
const { createServer } = require('node:http');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { ResourceManager } = require('../electron/resources.cjs');
const { WorkerClient } = require('../electron/worker.cjs');

const root = path.join(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'bestdict-resource-test-'));
const python = process.env.BESTDICT_PYTHON || path.join(root, 'runtime/python/python.exe');
const script = path.join(root, 'backend/worker.py');
const events = [];
const manager = new ResourceManager({ assets: path.join(root, 'resources'), library: temporary, python, script, progress: event => events.push(event) });
const dictionary = new WorkerClient(python, script, path.join(root, 'resources'), 'dictionary');
const fixture = path.join(temporary, 'source.jsonl.gz');
fs.writeFileSync(fixture, gzipSync([
  { word: 'hola', lang_code: 'es', pos: 'intj', senses: [{ glosses: ['你好'] }] },
  { word: 'café', lang_code: 'fr', pos: 'noun', senses: [{ glosses: ['咖啡；咖啡馆'] }] },
  { word: '猫', lang_code: 'ja', pos: 'noun', senses: [{ glosses: ['猫'] }], forms: [{ form: 'ねこ', tags: ['hiragana'] }] },
  { word: 'が', lang_code: 'ja', pos: 'particle', senses: [{ glosses: ['主格助词'] }] },
  { word: '사랑', lang_code: 'ko', senses: [{ glosses: ['爱，爱情'] }] },
].map(row => JSON.stringify(row)).join('\n')));
after(() => { manager.cancel(); dictionary.stop(); /* Test artifacts stay in the OS temp directory. */ });

test('optional dictionaries start uninstalled; imports select the right language and normalize Unicode', async () => {
  assert.ok(manager.list().filter(item => !item.builtIn).every(item => !item.installed));
  assert.equal(manager.argosStatus().ready, false);
  assert.equal(manager.hyStatus().ready, false);
  assert.deepEqual(manager.downloadLinks('argos'), manager.argosSpec.packages.map(p => p.url));
  assert.deepEqual(manager.downloadLinks('hy-mt1.5'), [manager.hySpec.url]);
  assert.throws(() => manager.downloadLinks('unknown'), /无效/);
  await assert.rejects(manager.install('not-a-dictionary', fixture), /无效/);
  const cases = [
    ['wiktionary-es-zh', 'HOLA', 'hola', /你好/],
    ['wiktionary-fr-zh', 'CAFE', 'café', /咖啡/],
    ['wiktionary-ja-zh', 'ねこ', '猫', /猫/],
    ['wiktionary-ko-zh', '사랑', '사랑', /爱情/],
  ];
  for (const [id, query, expected, gloss] of cases) {
    await manager.install(id, fixture);
    assert.equal(manager.list().find(item => item.id === id).installed, true);
    const result = await dictionary.request('lookup', { text: query, database: manager.database(id) });
    assert.equal(result.entries[0].word, expected);
    assert.match(result.entries[0].translation, gloss);
    assert.ok(fs.readFileSync(path.join(temporary, id, 'ATTRIBUTION.txt'), 'utf8').includes('Wiktionary contributors'));
  }
  const kana = await dictionary.request('lookup', { text: 'が', database: manager.database('wiktionary-ja-zh') });
  assert.equal(kana.entries[0].word, 'が');
  assert.ok(events.some(event => event.phase === 'complete'));
});

test('wrong-language and malformed imports never mark a dictionary installed', async () => {
  const isolated = new ResourceManager({ assets: path.join(root, 'resources'), library: path.join(temporary, 'bad'), python, script, progress: () => {} });
  const bad = path.join(temporary, 'bad.jsonl');
  fs.writeFileSync(bad, JSON.stringify({ word: 'hello', lang_code: 'en', senses: [{ glosses: ['你好'] }] }));
  await assert.rejects(isolated.install('wiktionary-es-zh', bad), /没有所选语言/);
  assert.equal(isolated.list().find(item => item.id === 'wiktionary-es-zh').installed, false);
  assert.ok(!fs.existsSync(path.join(temporary, 'bad/wiktionary-es-zh/dictionary.db.building')));
  fs.writeFileSync(bad, '{malformed');
  await assert.rejects(isolated.install('wiktionary-fr-zh', bad));
  assert.equal(isolated.list().find(item => item.id === 'wiktionary-fr-zh').installed, false);
  await assert.rejects(isolated.install('hy-mt1.5', bad), /官方/);
  assert.equal(isolated.hyStatus().ready, false);
  isolated.cancel();
});

test('explicit downloads report progress, install, reuse the shared source and cancel incomplete transfers', async () => {
  const sourceData = fs.readFileSync(fixture);
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    if (request.url === '/slow') {
      response.writeHead(200, { 'Content-Length': 2 * 1024 * 1024 });
      response.write(Buffer.alloc(1024 * 1024 + 1024));
      return;
    }
    response.writeHead(200, { 'Content-Length': sourceData.length });
    response.end(sourceData);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const localAssets = path.join(temporary, 'assets');
  fs.mkdirSync(localAssets);
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'resources/dictionaries.json')));
  catalog.source.url = `http://127.0.0.1:${port}/data`;
  fs.writeFileSync(path.join(localAssets, 'dictionaries.json'), JSON.stringify(catalog));
  fs.copyFileSync(path.join(root, 'resources/hy-model.json'), path.join(localAssets, 'hy-model.json'));
  fs.copyFileSync(path.join(root, 'resources/argos-model.json'), path.join(localAssets, 'argos-model.json'));
  const emitted = [];
  const downloader = new ResourceManager({ assets: localAssets, library: path.join(temporary, 'download'), python, script, progress: e => emitted.push(e) });
  let cancelling;
  try {
    await downloader.install('wiktionary-es-zh');
    await downloader.install('wiktionary-fr-zh');
    assert.equal(requests, 1, 'Only one source download is needed for multiple languages.');
    assert.ok(emitted.some(e => e.phase === 'downloading' && e.received > 0));
    assert.equal(downloader.list().find(d => d.id === 'wiktionary-fr-zh').installed, true);
    catalog.source.url = `http://127.0.0.1:${port}/slow`;
    fs.writeFileSync(path.join(localAssets, 'dictionaries.json'), JSON.stringify(catalog));
    let signal;
    const firstBlock = new Promise(resolve => { signal = resolve; });
    cancelling = new ResourceManager({ assets: localAssets, library: path.join(temporary, 'cancel'), python, script, progress: e => { if (e.phase === 'downloading') signal(); } });
    const install = cancelling.install('wiktionary-ko-zh');
    const rejected = assert.rejects(install, /取消/);
    await firstBlock;
    cancelling.cancel();
    await rejected;
    assert.equal(cancelling.list().find(d => d.id === 'wiktionary-ko-zh').installed, false);
    assert.equal(fs.existsSync(path.join(temporary, 'cancel/cache/wiktionary-zh.jsonl.gz.part')), false);
  } finally {
    downloader.cancel(); cancelling?.cancel(); server.closeAllConnections(); server.close();
  }
});

test('manual Argos imports identify both directions by checksum, accept renamed files and never download', async () => {
  const assets = path.join(temporary, 'argos-import-assets');
  fs.mkdirSync(assets);
  for (const name of ['dictionaries.json', 'hy-model.json']) fs.copyFileSync(path.join(root, 'resources', name), path.join(assets, name));
  const packages = [];
  const filenames = [];
  for (const pair of ['en_zh', 'zh_en']) {
    const file = path.join(temporary, `renamed-${pair}.argosmodel`);
    const code = `import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n for name in ['model/model.bin','model/config.json','sentencepiece.model']:\n  z.writestr('translate-test/'+name,sys.argv[2])`;
    const made = spawnSync(python, ['-c', code, file, pair], { windowsHide: true, encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    const bytes = fs.readFileSync(file);
    packages.push({ pair, filename: pair + '.argosmodel', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), url: 'http://127.0.0.1:1/must-not-download' });
    filenames.push(file);
  }
  fs.writeFileSync(path.join(assets, 'argos-model.json'), JSON.stringify({ ...manager.argosSpec, packages }));
  const progress = [];
  const imported = new ResourceManager({ assets, library: path.join(temporary, 'argos-import'), python, script, progress: e => progress.push(e) });
  try {
    await assert.rejects(imported.install('argos', [filenames[0]]), /同时选择/);
    await assert.rejects(imported.install('argos', [filenames[0], filenames[0]]), /校验失败/);
    assert.equal(imported.argosStatus().ready, false);
    await imported.install('argos', [...filenames].reverse());
    assert.equal(imported.argosStatus().ready, true);
    for (const pair of ['en_zh', 'zh_en']) assert.equal(fs.readFileSync(path.join(imported.argosRoot(), 'models', pair, 'model/model.bin'), 'utf8'), pair);
    assert.equal(progress.some(p => p.phase === 'downloading'), false);
  } finally { await imported.cancel(); }
});

test('Argos downloads are optional, checksummed and ready only after both directions install', async () => {
  const assets = path.join(temporary, 'argos-assets');
  fs.mkdirSync(assets);
  for (const name of ['dictionaries.json', 'hy-model.json']) fs.copyFileSync(path.join(root, 'resources', name), path.join(assets, name));
  const archive = path.join(temporary, 'tiny.argosmodel');
  const fixtureCode = `import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n for name in ['model/model.bin','model/config.json','sentencepiece.model']:\n  z.writestr('translate-test/'+name,'fixture')`;
  const generated = spawnSync(python, ['-c', fixtureCode, archive], { windowsHide: true, encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  const bytes = fs.readFileSync(archive);
  const hash = createHash('sha256').update(bytes).digest('hex');
  let invalid = true;
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    const body = invalid && request.url === '/zh_en' ? Buffer.from('incomplete') : bytes;
    response.writeHead(200, { 'Content-Length': body.length }); response.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const spec = { ...JSON.parse(fs.readFileSync(path.join(root, 'resources/argos-model.json'))),
    packages: ['en_zh', 'zh_en'].map(pair => ({ pair, filename: pair + '.argosmodel', bytes: bytes.length, sha256: hash, url: `${url}/${pair}` })) };
  fs.writeFileSync(path.join(assets, 'argos-model.json'), JSON.stringify(spec));
  const library = path.join(temporary, 'argos-download');
  const emitted = [];
  const optional = new ResourceManager({ assets, library, python, script, progress: e => emitted.push(e) });
  try {
    assert.equal(optional.argosStatus().ready, false);
    assert.equal(requests, 0, 'Listing resources must not download models.');
    await assert.rejects(optional.install('argos'), /校验失败/);
    assert.equal(optional.argosStatus().ready, false);
    assert.equal(fs.existsSync(path.join(library, 'argos/metadata.json')), false);
    assert.equal(fs.existsSync(path.join(library, 'argos/models.incoming')), false);
    invalid = false;
    await optional.install('argos');
    assert.equal(optional.argosStatus().ready, true);
    assert.equal(requests, 3, 'Retry reuses the first verified archive.');
    assert.ok(emitted.some(e => e.phase === 'downloading'));
    fs.unlinkSync(path.join(optional.argosRoot(), 'models/zh_en/sentencepiece.model'));
    assert.equal(optional.argosStatus().ready, false, 'A missing direction must not be selectable.');
  } finally { await optional.cancel(); server.closeAllConnections(); server.close(); }
});
