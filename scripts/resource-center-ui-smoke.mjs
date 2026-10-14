import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeElectronTest } from './close-electron-test.mjs';

const library = await mkdtemp(path.join(os.tmpdir(), 'bestdict-center-ui-'));
const shared = gzipSync([
  { word: 'hola', lang_code: 'es', senses: [{ glosses: ['你好'] }] },
  { word: '猫', lang_code: 'ja', senses: [{ glosses: ['猫'] }], forms: [{ form: 'ねこ', tags: ['hiragana'] }] },
  { word: '사랑', lang_code: 'ko', senses: [{ glosses: ['爱'] }] },
  { word: 'bonjour', lang_code: 'fr', senses: [{ glosses: ['你好'] }] },
].map(row => JSON.stringify(row)).join('\n'));
const audioModel = Buffer.alloc(65536, 23);
let firstOCR = true, rawRequests = 0, resumed = false;
const server = createServer((req, res) => {
  if (req.url === '/dictionary') { rawRequests++; return res.end(shared); }
  if (req.url === '/bad-hy') return res.end('corrupted!');
  res.setHeader('ETag', '"fixed"');
  if (req.url === '/ocr-a' && firstOCR) {
    firstOCR = false; res.setHeader('Content-Length', audioModel.length); res.write(audioModel.subarray(0, 32768)); return;
  }
  const offset = Number(req.headers.range?.match(/\d+/)?.[0] || 0);
  if (offset) { resumed = true; res.statusCode = 206; res.setHeader('Content-Range', 'bytes ' + offset + '-' + (audioModel.length - 1) + '/' + audioModel.length); }
  res.end(audioModel.subarray(offset));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = 'http://127.0.0.1:' + server.address().port;
const env = { ...process.env, BESTDICT_TEST: '1', BESTDICT_LIBRARY: library, BESTDICT_TEST_SHORTCUT: 'Control+Alt+Shift+F14' };
delete env.ELECTRON_RUN_AS_NODE;
const executablePath = process.env.BESTDICT_TEST_EXE;
const desktop = await electron.launch({ executablePath, args: executablePath ? [] : ['.'], env });
const output = path.resolve('test-results/resource-center');
await mkdir(output, { recursive: true });
try {
  const page = await desktop.firstWindow(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.getByText('离线资源已就绪').waitFor();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('tab', { name: '模型与词库', exact: true }).click();
  const center = page.getByTestId('resource-center');
  await page.getByTestId('resource-multi-dictionaries').waitFor();
  assert.equal(await page.getByRole('tab').count(), 4);
  assert.equal(await center.locator('.resource-item').count(), 5);
  assert.equal(await center.locator('details[open]').count(), 0);
  await page.screenshot({ path: path.join(output, 'zh-initial.png') });
  if (process.platform === 'win32') {
    await page.getByRole('tab', { name: '发音', exact: true }).click();
    await page.evaluate(() => window.bestdict.startCapture());
    await center.waitFor();
  }
  const fixtureAssets = path.join(library, 'fixture-assets');
  await mkdir(fixtureAssets);
  const dictionarySpec = await desktop.evaluate(async (_electron, { assets, url, hash }) => {
    const { resources, ocr } = globalThis.__bestdictNative.getServices();
    resources.catalog.source.url = url + '/dictionary';
    resources.installer.config.assets = assets;
    resources.hySpec.url = url + '/bad-hy'; resources.hySpec.bytes = 10;
    resources.hySpec.sha256 = '0'.repeat(64);
    ocr.spec.files = ['a', 'b'].map(letter => ({ name: 'fixture-' + letter + '.onnx', bytes: 65536, sha256: hash, url: url + '/ocr-' + letter }));
    return resources.catalog;
  }, { assets: fixtureAssets, url, hash: createHash('sha256').update(audioModel).digest('hex') });
  await writeFile(path.join(fixtureAssets, 'dictionaries.json'), JSON.stringify(dictionarySpec));
  await center.getByRole('checkbox', { name: '选择 多语言词库', exact: true }).check();
  await center.getByRole('checkbox', { name: '选择 混元 AI 翻译', exact: true }).check();
  await center.getByRole('button', { name: /下载所选/ }).click();
  await page.waitForFunction(() => window.bestdict.getDownloads().then(value => value.entries.find(entry => entry.id === 'multi-dictionaries').ready));
  await page.getByTestId('resource-hy-mt2').getByRole('alert').waitFor();
  const failed = page.getByTestId('resource-hy-mt2');
  await failed.locator('summary').click();
  await failed.getByRole('button', { name: '清理下载缓存', exact: true }).click();
  await failed.getByRole('alert').waitFor({ state: 'detached' });
  assert.equal(rawRequests, 1);
  const installed = await page.evaluate(() => window.bestdict.getResources());
  assert.equal(installed.dictionaries.filter(entry => !entry.builtIn && entry.installed).length, 4);
  if (process.platform === 'win32') {
    const ocr = page.getByTestId('resource-ocr');
    await ocr.getByRole('button', { name: '下载', exact: true }).click();
    await desktop.evaluate(() => new Promise(resolve => {
      const timer = setInterval(() => { if (globalThis.__bestdictNative.getServices().ocr.progress?.received > 0) { clearInterval(timer); resolve(); } }, 10);
    }));
    await ocr.getByRole('button', { name: '暂停', exact: true }).click();
    await page.waitForFunction(() => window.bestdict.getDownloads().then(value => value.jobs.find(job => job.id === 'ocr')?.state === 'paused'));
    await ocr.getByRole('button', { name: '继续下载', exact: true }).click();
    await page.waitForFunction(() => window.bestdict.getDownloads().then(value => value.entries.find(entry => entry.id === 'ocr').ready));
    assert.equal(resumed, true);
  }
  await page.getByRole('tab', { name: '发音', exact: true }).click();
  await page.locator('#system-en').waitFor();
  assert.equal(await page.getByRole('button', { name: '下载语音包', exact: true }).count(), 0);
  await page.getByRole('button', { name: '前往下载', exact: true }).click();
  await center.waitFor();
  assert.equal(await page.getByRole('tab', { name: '模型与词库', exact: true }).getAttribute('aria-selected'), 'true');
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await page.evaluate(() => window.bestdict.setSettings({ locale: 'en', theme: 'dark' }));
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Models & dictionaries', exact: true }).click();
  await center.waitFor();
  await page.screenshot({ path: path.join(output, 'en-installed.png') });
  assert.deepEqual(errors, []);
  console.log('Resource center UI passed: four tabs, one dictionary pack, shared download, batch queue, isolated failure, OCR pause/resume, system voices and navigation.');
} finally {
  await closeElectronTest(desktop);
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  assert.equal(path.dirname(library), path.resolve(os.tmpdir()));
  assert.ok(path.basename(library).startsWith('bestdict-center-ui-'));
  await rm(library, { recursive: true, force: true });
}
