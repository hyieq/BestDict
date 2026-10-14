import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

// Detach Playwright's Node inspector before Cocoa completes native shutdown.
export async function closeElectronTest(desktop) {
  await desktop.evaluate(({ app }) => {
    const nativeQuit = app.quit.bind(app);
    app.quit = () => { setImmediate(nativeQuit); };
  });
  let timer, diagnosticTimer;
  if (process.platform === 'darwin') {
    diagnosticTimer = setTimeout(async () => {
      try {
        const directory = path.resolve('test-results/shutdown');
        await mkdir(directory, { recursive: true });
        const output = path.join(directory, `electron-${desktop.process().pid}.sample.txt`);
        execFile('/usr/bin/sample', [String(desktop.process().pid), '2', '-file', output], error => {
          console.log(error ? `Shutdown sample failed: ${error.message}` : `Shutdown sample: ${output}`);
        });
      } catch (error) { console.log(`Shutdown diagnostics failed: ${error.message}`); }
    }, 15000);
    diagnosticTimer.unref();
  }
  try {
    await Promise.race([desktop.close(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Graceful Electron shutdown timed out')), process.platform === 'darwin' ? 60000 : 15000);
    })]);
  } finally { clearTimeout(timer); clearTimeout(diagnosticTimer); }
}
