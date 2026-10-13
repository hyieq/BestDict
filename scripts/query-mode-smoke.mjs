import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
const env = { ...process.env, BESTDICT_TEST: '1', BESTDICT_TEST_SHORTCUT: 'Control+Alt+Shift+F10' };
delete env.ELECTRON_RUN_AS_NODE;
const executablePath = process.env.BESTDICT_TEST_EXE;
const desktop = await electron.launch({ executablePath, args: executablePath ? [] : ['.'], env });
try {
  const page = await desktop.firstWindow();
  await page.getByText('离线资源已就绪').waitFor();
  await desktop.evaluate(() => {
    const { resources, translator } = globalThis.__bestdictNative.getServices();
    const status = resources.argosStatus.bind(resources);
    resources.argosStatus = () => ({ ...status(), ready: true });
    globalThis.__queryCalls = [];
    const request = translator.request.bind(translator);
    translator.request = (method, params) => {
      if (method !== 'translate') return request(method, params);
      globalThis.__queryCalls.push(params.text);
      if (globalThis.__delayTranslation) return new Promise(resolve => { globalThis.__finishTranslation = () => resolve({ text: 'obsolete translation', direction: 'en-zh', cached: false }); });
      return Promise.resolve({ text: `Translated: ${params.text}`, direction: 'en-zh', cached: false });
    };
  });
  await page.evaluate(() => window.bestdict.setSettings({ translationEngine: 'argos' }));
  await page.reload();
  const input = page.getByRole('textbox', { name: '输入单词或句子' });
  const calls = () => desktop.evaluate(() => globalThis.__queryCalls.length);
  const automatic = page.getByRole('button', { name: '自动', exact: true });
  await input.fill('apple');
  await page.getByTestId('entry-word').filter({ hasText: 'apple' }).waitFor();
  await page.getByRole('button', { name: '翻译', exact: false }).filter({ has: page.locator('span', { hasText: 'Ctrl' }) }).click();
  await page.getByTestId('translation-result').waitFor();
  assert.equal(await automatic.getAttribute('aria-pressed'), 'true');
  await input.fill('banana');
  await page.getByTestId('entry-word').filter({ hasText: 'banana' }).waitFor();
  const before = await calls();
  await page.waitForTimeout(700);
  assert.equal(await calls(), before, 'Editing after one-shot translation returns to dictionary lookup.');
  await input.press('Control+Enter');
  await page.getByTestId('translation-result').waitFor();
  await page.getByRole('button', { name: '清空', exact: true }).click();
  const afterClear = await calls();
  for (const text of ['a', 'ap', 'app', 'appl', 'apple', 'qzx imaginary phrase']) {
    await input.fill(text);
    await page.waitForTimeout(650);
    assert.equal(await calls(), afterClear, `Typing ${text} must not trigger translation.`);
  }
  await input.fill('Please send me the report before Friday.');
  await page.getByTestId('translation-result').waitFor();
  assert.equal(await calls(), afterClear + 1, 'Automatic sentence detection still works after debounce.');
  await page.getByRole('button', { name: '句子翻译', exact: true }).click();
  await input.fill('apple');
  await page.getByTestId('translation-result').filter({ hasText: 'apple' }).waitFor();
  await input.fill('banana');
  await page.getByTestId('translation-result').filter({ hasText: 'banana' }).waitFor();
  await input.press('Control+A');
  await input.press('Backspace');
  assert.equal(await automatic.getAttribute('aria-pressed'), 'true', 'Clearing explicit sentence mode restores Auto.');
  await input.fill('apple');
  await page.getByTestId('entry-word').filter({ hasText: 'apple' }).waitFor();
  await desktop.evaluate(() => { globalThis.__delayTranslation = true; });
  await input.press('Control+Enter');
  await page.getByText('正在翻译…', { exact: true }).waitFor();
  await input.fill('banana');
  await page.getByTestId('entry-word').filter({ hasText: 'banana' }).waitFor();
  await desktop.evaluate(() => globalThis.__finishTranslation());
  await page.waitForTimeout(100);
  assert.equal(await page.getByTestId('translation-result').count(), 0, 'Obsolete sentence output cannot replace a new word.');
  console.log('Query mode: one-shot button/shortcut, clear button/keyboard, letter-by-letter lookup, unknown phrase, automatic sentence, explicit sentence mode and obsolete results passed.');
} finally { await desktop.close(); }
