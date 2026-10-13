import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const tools = path.join(root, '.cache', 'builder');
const env = { ...process.env };
const output = path.resolve(root, env.BESTDICT_RELEASE_DIR || 'release');
for (const [name, relative] of [
  ['ELECTRON_BUILDER_NSIS_DIR', 'nsis'],
  ['ELECTRON_BUILDER_NSIS_RESOURCES_DIR', 'nsis-resources'],
  ['ELECTRON_BUILDER_RCEDIT_PATH', 'rcedit'],
  ['ELECTRON_BUILDER_7ZIP_PATH', '7zip/bin/7za.exe'],
]) {
  if (!env[name] && existsSync(path.join(tools, relative))) env[name] = path.join(tools, relative);
}
const child = spawn(process.execPath, [path.join(root, 'node_modules/electron-builder/cli.js'), '--win', '--x64', '--publish', 'never', `--config.directories.output=${output}`], { cwd: root, env, stdio: 'inherit', windowsHide: true });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => {
  process.exitCode = code ?? 1;
  if (code !== 0) return;
  const assets = path.join(output, 'win-unpacked/resources/assets');
  const forbidden = [];
  function inspect(folder) {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'models') forbidden.push(file);
        inspect(file);
      } else if (/\.(gguf|argosmodel)$|^model\.bin$/i.test(entry.name)) forbidden.push(file);
    }
  }
  inspect(assets);
  if (forbidden.length) {
    console.error('Unexpected bundled translation weights:', forbidden);
    process.exitCode = 1;
  } else console.log('Verified: release assets contain no Argos or HY translation weights.');
});
