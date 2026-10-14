// Ad-hoc sign embedded native executables after copying, before electron-builder signs the app.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const machO = new Set(['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']);
exports.default = async function(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const resources = path.join(context.appOutDir, 'BestDict.app/Contents/Resources');
  function signTree(folder) {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) signTree(file);
      else if (entry.isFile()) {
        const fd = fs.openSync(file, 'r');
        const header = Buffer.alloc(4);
        try { fs.readSync(fd, header, 0, 4, 0); } finally { fs.closeSync(fd); }
        if (machO.has(header.toString('hex'))) execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', file], { stdio: 'inherit' });
      }
    }
  }
  signTree(path.join(resources, 'python'));
  signTree(path.join(resources, 'llama'));
};
