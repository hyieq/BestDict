import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const env = { ...process.env, BESTDICT_TEST: '1', BESTDICT_TEST_SHORTCUT: 'Control+Alt+Shift+F10' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.BESTDICT_LIBRARY;
const executablePath = process.env.BESTDICT_TEST_EXE;
const desktop = await electron.launch({ executablePath, args: [...(executablePath ? [] : ['.']), '--force-device-scale-factor=1'], env });
const output = path.resolve('test-results/glass');
await mkdir(output, { recursive: true });
const errors = [];
try {
  const page = await desktop.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.getByText('离线资源已就绪').waitFor();
  const input = page.locator('.search-box textarea');
  const nativeAppearance = await page.evaluate(() => window.bestdict.getAppearance());
  await desktop.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const setBackgroundColor = window.setBackgroundColor.bind(window);
    window.setBackgroundColor = color => { globalThis.__requestedBackground = color; setBackgroundColor(color); };
  });

  async function capture(name) {
    await page.evaluate(() => {
      for (const animation of document.getAnimations()) {
        if (animation.effect?.getTiming().iterations !== Infinity) animation.finish();
      }
    });
    // Electron capturePage preserves the whole viewport at non-default page zoom.
    const png = await desktop.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
    await writeFile(path.join(output, name), Buffer.from(png, 'base64'));
  }

  async function assertLayout(label) {
    const layout = await page.evaluate(() => {
      const fits = selector => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1;
      };
      return {
        overflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight,
        controls: ['.search-box', '.ai-button-group', '.search-toolbar', '.statusbar'].every(fits),
        resultHeight: document.querySelector('.result-area').getBoundingClientRect().height,
      };
    });
    assert.equal(layout.overflow, false, label + ': no viewport overflow');
    assert.equal(layout.controls, true, label + ': controls stay visible');
    assert.ok(layout.resultHeight >= 120, label + ': readable result area');
  }

  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => window.bestdict.setSettings({ theme }), theme);
    await page.reload();
    await page.locator(`html[data-theme="${theme}"]`).waitFor();
    const appearance = await page.evaluate(() => window.bestdict.getAppearance());
    const native = await desktop.evaluate(({ nativeTheme }) => ({ dark: nativeTheme.shouldUseDarkColors, background: globalThis.__requestedBackground }));
    assert.equal(native.dark, theme === 'dark');
    assert.equal(appearance.dark, native.dark);
    assert.equal(await page.locator('html').getAttribute('data-material'), appearance.material);
    if (appearance.material === 'acrylic') assert.equal(native.background, '#00000000');
    await input.fill('serendipity');
    await page.getByTestId('entry-word').filter({ hasText: 'serendipity' }).waitFor();
    await assertLayout(theme);
    await capture(`${theme}.png`);
  }

  for (const locale of ['zh-CN', 'en']) {
    await page.evaluate(locale => window.bestdict.setSettings({ locale }), locale);
    await page.reload();
    await page.locator(`html[lang="${locale}"]`).waitFor();
    for (const [width, height, zoom] of [[780, 580, 1], [1020, 720, 1.5], [1320, 860, 1]]) {
      await desktop.evaluate(({ BrowserWindow }, { width, height, zoom }) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.setSize(width, height);
        window.webContents.setZoomFactor(zoom);
      }, { width, height, zoom });
      await page.waitForTimeout(200);
      await input.fill('serendipity');
      await page.getByTestId('entry-word').filter({ hasText: 'serendipity' }).waitFor();
      await assertLayout(`${locale} ${width} ${zoom}`);
      const singleHeight = await input.evaluate(el => el.clientHeight);
      await input.fill('Please preserve paragraph breaks when translating this text.\nThis is the second paragraph.\n这是第三段，用于检查多行输入和小窗口布局。');
      await page.getByTestId('translation-disabled').waitFor();
      assert.ok(await input.evaluate(el => el.clientHeight) > singleHeight, 'Long input grows without resizing the window');
      await assertLayout(`${locale} multiline ${width} ${zoom}`);
      await capture(`${locale}-${width}-${zoom}.png`);
    }
  }

  // Simulate the OS preference in this isolated test process; do not change Windows settings.
  await desktop.evaluate(({ nativeTheme }) => {
    globalThis.__transparencyDescriptor = Object.getOwnPropertyDescriptor(nativeTheme, 'prefersReducedTransparency');
    Object.defineProperty(nativeTheme, 'prefersReducedTransparency', { configurable: true, get: () => true });
    nativeTheme.emit('updated');
  });
  await page.locator('html[data-material="solid"]').waitFor();
  assert.equal(await page.locator('.search-box').evaluate(el => getComputedStyle(el).backdropFilter), 'none');
  const solid = await desktop.evaluate(() => globalThis.__requestedBackground);
  assert.notEqual(solid, '#00000000');
  await desktop.evaluate(({ nativeTheme }) => {
    if (globalThis.__transparencyDescriptor) Object.defineProperty(nativeTheme, 'prefersReducedTransparency', globalThis.__transparencyDescriptor);
    else delete nativeTheme.prefersReducedTransparency;
    nativeTheme.emit('updated');
  });
  await page.waitForFunction(material => document.documentElement.dataset.material === material, nativeAppearance.material);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await input.fill('apple');
  await page.getByTestId('entry-word').filter({ hasText: 'apple' }).waitFor();
  assert.equal(await page.locator('.entry-panel').evaluate(el => getComputedStyle(el).animationName), 'none');
  assert.deepEqual(errors, []);
  const result = { passed: true, nativeAppearance, checks: ['native and renderer themes agree', 'native backdrop configuration', 'Chinese and English', 'compact and 150% zoom layouts', 'multiline input growth', 'simulated OS reduced transparency', 'reduced motion', 'no renderer errors'] };
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await desktop.close();
}
