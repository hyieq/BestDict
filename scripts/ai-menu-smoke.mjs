import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const env = { ...process.env, BESTDICT_TEST: '1', BESTDICT_TEST_SHORTCUT: 'Control+Alt+Shift+F10' };
delete env.ELECTRON_RUN_AS_NODE;
const executablePath = process.env.BESTDICT_TEST_EXE;
const desktop = await electron.launch({ executablePath, args: [...(executablePath ? [] : ['.']), '--force-device-scale-factor=1.5'], env });
try {
  const page = await desktop.firstWindow();
  await page.getByText('离线资源已就绪').waitFor();
  const trigger = page.getByRole('button', { name: '翻译风格', exact: true });
  const menu = page.getByRole('menu', { name: '翻译风格', exact: true });
  async function checkPosition() {
    await menu.waitFor();
    const bounds = await page.evaluate(() => {
      const box = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
      return { menu: box('.ai-style-menu'), picker: box('.ai-style-picker'), width: innerWidth, height: innerHeight };
    });
    assert.ok(Math.abs(bounds.menu.right - bounds.picker.right) < 2, 'Menu follows the button horizontally.');
    assert.ok(Math.abs(bounds.menu.top - bounds.picker.bottom) < 2, 'Menu opens immediately below the button.');
    assert.ok(bounds.menu.left >= 0 && bounds.menu.right <= bounds.width && bounds.menu.bottom <= bounds.height, 'Menu remains inside the app.');
  }
  await trigger.click();
  await checkPosition();
  await desktop.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; const b = w.getBounds(); w.setPosition(b.x + 90, b.y + 40); });
  await checkPosition();
  await page.keyboard.press('End');
  assert.equal(await page.getByRole('menuitem', { name: '管理翻译风格…' }).evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await menu.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.querySelector('.ai-style-select').textContent.includes('专业'));
  await trigger.click();
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => document.visibilityState), 'visible', 'Escape closes only the menu.');
  await trigger.click();
  await page.getByRole('textbox', { name: '输入单词或句子' }).click();
  await menu.waitFor({ state: 'hidden' });
  await page.evaluate(() => window.bestdict.setSettings({ theme: 'dark' }));
  await page.reload();
  await page.locator('html[data-theme="dark"]').waitFor();
  await desktop.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(820, 620); w.webContents.setZoomFactor(1.25); });
  await page.waitForTimeout(400);
  await trigger.click();
  await checkPosition();
  await page.waitForTimeout(200);
  await mkdir('test-results', { recursive: true });
  const capture = await desktop.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
  await writeFile('test-results/ai-menu-dark-scaled.png', Buffer.from(capture, 'base64'));
  console.log('AI menu: 150% DPI, window move, compact size, zoom, dark theme, keyboard selection, Escape and outside dismissal passed.');
} finally { await desktop.close(); }
