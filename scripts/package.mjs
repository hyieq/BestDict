import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const tools = path.join(root, '.cache', 'builder');
const env = { ...process.env };
const output = path.resolve(root, env.BESTDICT_RELEASE_DIR || 'release');
if (!['win32', 'darwin'].includes(process.platform)) throw new Error('Packaging supports Windows and macOS only.');
if (process.platform === 'darwin' && process.arch !== 'arm64') throw new Error('The macOS preview requires Apple Silicon.');
const mac = process.platform === 'darwin';
for (const [name, relative] of [
  ['ELECTRON_BUILDER_NSIS_DIR', 'nsis'],
  ['ELECTRON_BUILDER_NSIS_RESOURCES_DIR', 'nsis-resources'],
  ['ELECTRON_BUILDER_RCEDIT_PATH', 'rcedit'],
  ['ELECTRON_BUILDER_7ZIP_PATH', '7zip/bin/7za.exe'],
]) {
  if (!env[name] && existsSync(path.join(tools, relative))) env[name] = path.join(tools, relative);
}
const child = spawn(process.execPath, [path.join(root, 'node_modules/electron-builder/cli.js'), mac ? '--mac' : '--win', mac ? '--arm64' : '--x64', '--publish', 'never', `--config.directories.output=${output}`], { cwd: root, env, stdio: 'inherit', windowsHide: true });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => {
  process.exitCode = code ?? 1;
  if (code !== 0) return;
  const resources = path.join(output, mac ? 'mac-arm64/BestDict.app/Contents/Resources' : 'win-unpacked/resources');
  const assets = path.join(resources, 'assets');
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
  const ocrModels = path.join(output, 'win-unpacked/resources/python/Lib/site-packages/rapidocr/models');
  if (existsSync(ocrModels) && readdirSync(ocrModels).some(name => /\.onnx$/i.test(name))) forbidden.push(ocrModels);
  if (forbidden.length) {
    console.error('Unexpected bundled translation weights:', forbidden);
    process.exitCode = 1;
  } else console.log('Verified: release assets contain no Argos, HY or OCR weights.');
});
