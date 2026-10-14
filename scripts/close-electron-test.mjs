// Detach Playwright's Node inspector before Cocoa completes native shutdown.
export async function closeElectronTest(desktop) {
  await desktop.evaluate(({ app }) => {
    const nativeQuit = app.quit.bind(app);
    app.quit = () => { setImmediate(nativeQuit); };
  });
  let timer;
  try {
    await Promise.race([desktop.close(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Graceful Electron shutdown timed out')), 15000);
    })]);
  } finally { clearTimeout(timer); }
}
