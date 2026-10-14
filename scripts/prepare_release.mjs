import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function verifyReleaseAssets(directory, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid release version.');
  const installers = [`BestDict-${version}-x64-Setup.exe`, `BestDict-${version}-macOS-x64.dmg`, `BestDict-${version}-macOS-arm64.dmg`];
  const expected = [...installers, ...installers.map(name => `${name}.sha256`)];
  const files = await readdir(directory);
  if (files.some(name => /\.(exe|dmg|sha256)$/i.test(name) && !expected.includes(name))) throw new Error('Unexpected release asset.');
  for (const name of installers) {
    const file = path.join(directory, name);
    if ((await stat(file)).size === 0) throw new Error(`Empty installer: ${name}`);
    const manifest = (await readFile(`${file}.sha256`, 'utf8')).trim().match(/^([a-f\d]{64})\s+(.+)$/i);
    if (!manifest || manifest[2] !== name) throw new Error(`Invalid checksum manifest: ${name}`);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    if (hash.digest('hex') !== manifest[1].toLowerCase()) throw new Error(`Checksum mismatch: ${name}`);
  }
  return expected;
}

async function prepare() {
  const directory = process.argv[2] || 'release';
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  const version = pkg.version;
  if (process.env.RELEASE_TAG !== `v${version}` || lock.version !== version || lock.packages[''].version !== version) throw new Error('Release tag and package versions must match.');
  const readme = await readFile('README.md', 'utf8');
  if (!readme.includes(`badge/version-${version}-`)) throw new Error('README version badge is out of sync.');
  await verifyReleaseAssets(directory, version);
  const changelog = await readFile('CHANGELOG.md', 'utf8');
  const changes = changelog.match(new RegExp(`^## ${version.replaceAll('.', '\\.')}\\r?\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'));
  if (!changes || !changes[1].trim()) throw new Error(`Missing changelog for ${version}.`);
  const notes = [
    `BestDict ${version} · Windows x64 / macOS Intel / macOS Apple Silicon`, '',
    '- Windows：下载 `Setup.exe` 并运行安装。',
    '- Intel Mac：下载 `macOS-x64.dmg`，将 BestDict 拖入「应用程序」。',
    '- M 系列 Mac：下载 `macOS-arm64.dmg`，将 BestDict 拖入「应用程序」。', '',
    '三个安装包均包含 770,611 条 ECDICT 词条及必要运行时，无需另装 Python。翻译、语音和 OCR 模型按需下载，不随包提供。', '',
    'Mac 包使用临时签名，尚未经过 Apple Developer ID 签名和公证；首次打开可能需要在「系统设置 → 隐私与安全性」允许打开。截图翻译仅支持 Windows。', '',
    '## 更新内容', '', changes[1].trim(), '',
    '三个平台均经过资源及打包后桌面测试。每个安装包提供 SHA-256 校验文件。',
  ].join('\n');
  await writeFile(path.join(directory, 'release-notes.md'), notes, 'utf8');
  console.log('Verified all three installers and checksums; release notes are ready.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepare();
