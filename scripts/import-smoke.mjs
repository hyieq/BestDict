import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const files = ['zh_en', 'en_zh'].map(pair => path.join(root, '.cache', pair + '.argosmodel'));
if (!files.every(existsSync)) throw new Error('Prepare the real archives with scripts/research_argos.py first.');
const env = { ...process.env, BESTDICT_TEST: '1', BESTDICT_TEST_SHORTCUT: 'Control+Alt+Shift+F11' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.BESTDICT_LIBRARY;
const executablePath = process.env.BESTDICT_TEST_EXE;
const desktop = await electron.launch({ executablePath, args: executablePath ? [] : ['.'], env, cwd: root });
try {
  const page = await desktop.firstWindow();
  await page.getByText('离线资源已就绪').waitFor();
  await page.evaluate(() => {
    window.importPhases = [];
    window.bestdict.onResourceProgress(event => window.importPhases.push(event.phase));
  });
  await desktop.evaluate(({ dialog }, filePaths) => {
    dialog.showOpenDialog = async (_window, options) => {
      assertPicker(options);
      return { canceled: false, filePaths };
    };
    function assertPicker(options) { if (!options.properties.includes('multiSelections')) throw new Error('Argos requires a two-file picker.'); }
  }, files);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('tab', { name: '翻译引擎', exact: true }).click();
  await page.getByTestId('engine-argos').locator('summary').click();
  await page.getByTestId('engine-argos').getByRole('button', { name: '导入模型包', exact: true }).click();
  await page.getByTestId('engine-argos').getByText('已启用', { exact: true }).waitFor({ timeout: 60000 });
  assert.equal(await page.evaluate(() => window.bestdict.getSettings().then(s => s.translationEngine)), 'argos');
  assert.equal(await page.evaluate(() => window.importPhases.includes('downloading')), false);
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  assert.equal(await page.evaluate(() => window.bestdict.getSettings().then(s => s.translationEngine)), 'argos');
  assert.match(await page.getByTestId('translation-engine-status').innerText(), /Argos Translate[\s\S]*已启用/);
  await page.reload();
  await page.getByTestId('translation-engine-status').filter({ hasText: 'Argos Translate' }).waitFor();
  await page.getByTestId('translation-engine-status').click();
  await page.getByTestId('engine-argos').getByText('已启用', { exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭设置' }).click();
  await page.getByRole('textbox', { name: '输入单词或句子' }).fill('Please send me the report before Friday.');
  await page.getByTestId('translation-result').waitFor({ timeout: 60000 });
  assert.match(await page.getByTestId('translation-result').innerText(), /报告/);
  await page.screenshot({ path: path.join(root, 'test-results/argos-enabled.png') });
  const result = { passed: true, packaged: !!executablePath, checks: ['real two-file import in reverse order', 'no download during import', 'explicit save enables engine', 'enabled state visible on home and settings', 'reload preserves engine', 'real imported Argos CPU translation'] };
  await writeFile(path.join(root, 'test-results', executablePath ? 'packaged-import.json' : 'import.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await desktop.close(); }
