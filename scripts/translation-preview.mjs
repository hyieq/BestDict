// Capture the actual isolated client using an existing verified HY model. No downloads.
import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, link, copyFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const source = process.env.BESTDICT_PREVIEW_HY;
if (!source) throw new Error('Set BESTDICT_PREVIEW_HY to an existing hy-mt2 model directory.');
const library = await mkdtemp(path.join(os.tmpdir(), 'bestdict-translation-preview-'));
const target = path.join(library, 'hy-mt2');
await mkdir(target);
for (const file of ['metadata.json', 'Hy-MT2-1.8B-Q4_K_M.gguf']) await link(path.join(source, file), path.join(target, file)).catch(() => copyFile(path.join(source, file), path.join(target, file)));
const env = { ...process.env, BESTDICT_TEST: '1', BESTDICT_LIBRARY: library, BESTDICT_TEST_SHORTCUT: 'Control+Alt+Shift+F16' };
delete env.ELECTRON_RUN_AS_NODE;
const desktop = await electron.launch({ args: ['.', '--force-device-scale-factor=1'], env });
try {
  const page = await desktop.firstWindow();
  await page.getByText('离线资源已就绪').waitFor();
  assert.equal((await page.evaluate(() => window.bestdict.getResources())).hy.ready, true);
  await page.evaluate(() => window.bestdict.setSettings({ translationEngine: 'hy', theme: 'light', translationNoticeDismissed: true }));
  await desktop.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setSize(1020, 720); win.webContents.setZoomFactor(1); });
  await page.reload();
  const input = page.getByRole('textbox', { name: '输入单词或句子' });
  const sentence = 'Learning a language opens a new world.';
  const started = Date.now();
  await input.fill(sentence);
  await page.getByTestId('translation-result').waitFor({ timeout: 180000 });
  const result = await page.getByTestId('translation-result').innerText();
  assert.match(result, /语言/); assert.match(result, /世界/);
  console.log(JSON.stringify({ realInference: true, result, elapsedMs: Date.now() - started }));
  await input.fill(''); await input.fill(sentence);
  await page.getByTestId('translation-result').waitFor();
  await page.getByText('· 已缓存', { exact: false }).waitFor();
  await page.evaluate(() => { for (const animation of document.getAnimations()) if (animation.effect?.getTiming().iterations !== Infinity) animation.finish(); });
  await page.screenshot({ path: path.resolve('docs/assets/sentence-translation.png') });
} finally {
  await desktop.close();
  assert.ok(path.resolve(library).startsWith(path.resolve(os.tmpdir()) + path.sep + 'bestdict-translation-preview-'));
  await rm(library, { recursive: true, force: true });
}
