import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { closeElectronTest } from './close-electron-test.mjs';

const env = { ...process.env, BESTDICT_TEST: '1', BESTDICT_TEST_SHORTCUT: 'Control+Alt+Shift+F12' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.BESTDICT_LIBRARY;
const executablePath = process.env.BESTDICT_TEST_EXE;
const desktop = await electron.launch({ executablePath, args: [...(executablePath ? [] : ['.']), '--force-device-scale-factor=1'], env });
const output = path.resolve('test-results/settings');
await mkdir(output, { recursive: true });
const errors = [];
try {
  const page = await desktop.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  async function capture(name) {
    await page.evaluate(() => { for (const animation of document.getAnimations()) if (animation.effect?.getTiming().iterations !== Infinity) animation.finish(); });
    // capturePage retains the complete physical viewport at 150% page zoom.
    const png = await desktop.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
    await writeFile(path.join(output, name), Buffer.from(png, 'base64'));
  }
  await page.getByText('离线资源已就绪').waitFor();
  await assert.rejects(page.evaluate(() => window.bestdict.setSettings({ translationNoticeDismissed: 'yes' })), /提示显示设置无效/);
  await page.getByRole('textbox', { name: '输入单词或句子' }).fill('multilingual');
  await page.getByTestId('entry-word').filter({ hasText: 'multilingual' }).waitFor();
  await page.getByRole('button', { name: '关闭翻译状态提示', exact: true }).click();
  await page.getByTestId('translation-engine-notice').waitFor({ state: 'detached' });
  await page.evaluate(() => window.bestdict.setSettings({ theme: 'light' }));
  await page.locator('html[data-theme="light"]').waitFor();
  await capture('home.png');
  if (process.env.BESTDICT_UPDATE_PREVIEWS === '1') await copyFile(path.join(output, 'home.png'), path.resolve('docs/assets/light-dictionary.png'));

  for (const [locale, theme, width, height, zoom] of [
    ['zh-CN', 'light', 1020, 720, 1], ['en', 'dark', 1020, 720, 1],
    ['zh-CN', 'light', 780, 580, 1], ['en', 'dark', 780, 580, 1.5],
  ]) {
    await page.evaluate(({ locale, theme }) => window.bestdict.setSettings({ locale, theme }), { locale, theme });
    await desktop.evaluate(({ BrowserWindow }, { width, height, zoom }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setSize(width, height); window.webContents.setZoomFactor(zoom);
    }, { width, height, zoom });
    await page.reload();
    await page.getByText(locale === 'en' ? 'Offline resources ready' : '离线资源已就绪').waitFor();
    assert.equal(await page.getByTestId('translation-engine-notice').count(), 0);
    await page.getByRole('button', { name: locale === 'en' ? 'Settings' : '设置', exact: true }).click();
    const tabs = locale === 'en' ? ['General', 'Dictionaries', 'Translation engines', 'Speech', 'Screenshot translation'] : ['通用', '词库', '翻译引擎', '发音', '截图翻译'];
    for (const [index, name] of tabs.entries()) {
      await page.getByRole('tab', { name, exact: true }).click();
      if (index === 3) {
        await page.locator('#system-en').waitFor();
        await page.getByTestId('speech-cache').getByText(/0.*MiB/).waitFor();
      }
      if (index === 0) {
        const rows = await page.locator('.shortcut-row').evaluateAll(rows => rows.map(row => {
          const label = row.querySelector('label').getBoundingClientRect();
          const input = row.querySelector('input').getBoundingClientRect();
          return { ordered: label.right <= input.left, aligned: Math.abs((label.top + label.bottom - input.top - input.bottom) / 2) < 3 };
        }));
        assert.ok(rows.length >= 2 && rows.every(row => row.ordered && row.aligned), 'Shortcut labels and fields share a row.');
        const help = page.locator('.resource-details').filter({ has: page.getByText(locale === 'en' ? 'Usage notes' : '使用说明', { exact: true }) });
        assert.equal(await help.getAttribute('open'), null);
        await help.locator('summary').click();
        await help.getByText(locale === 'en' ? 'Click a shortcut field, then press the key combination.' : '点击快捷键输入框，再按组合键。', { exact: true }).waitFor();
        await help.locator('summary').click();
      }
      const layout = await page.evaluate(() => {
        const dialog = document.querySelector('.settings-dialog').getBoundingClientRect();
        const footer = document.querySelector('.dialog-footer').getBoundingClientRect();
        const body = document.querySelector('.settings-body');
        return { fits: dialog.left >= 0 && dialog.right <= innerWidth + 1 && dialog.top >= 0 && dialog.bottom <= innerHeight + 1,
          footerFits: footer.bottom <= innerHeight + 1, horizontalOverflow: body.scrollWidth > body.clientWidth + 1 };
      });
      assert.deepEqual(layout, { fits: true, footerFits: true, horizontalOverflow: false }, `${locale} ${zoom} ${name}`);
      await page.locator('.settings-body').evaluate(body => { body.scrollTop = 0; });
      await capture(`${locale}-${theme}-${width}-${zoom}-${index}.png`);
    }
    await page.getByRole('button', { name: locale === 'en' ? 'Close settings' : '关闭设置', exact: true }).click();
  }
  assert.equal(await desktop.evaluate(() => globalThis.__bestdictNative.readSettings().translationNoticeDismissed), true);
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, checks: ['notice dismissal persisted', 'settings do not restore dismissed notice', 'help collapsed and expandable', 'shortcut row alignment', 'all five tabs', 'Chinese light and English dark', 'small window and 150% zoom', 'no horizontal clipping', 'footer stays visible'] }, null, 2));
  console.log('Settings UI passed: persistent notice dismissal, compact controls, expandable help and responsive tabs.');
} finally { await closeElectronTest(desktop); }
