"""Bundle the small official CPU runner; model weights remain an optional download."""
import hashlib
import json
import shutil
import platform
import sys
import tarfile
import zipfile
from pathlib import Path
from setup_assets import download

root = Path(__file__).resolve().parents[1]
model = json.loads((root / 'resources/hy-model.json').read_text(encoding='utf-8'))
mac = sys.platform == 'darwin'
architecture = {'arm64': 'arm64', 'x86_64': 'x64'}.get(platform.machine()) if mac else 'x64'
if mac and not architecture:
    raise RuntimeError('macOS runtime preparation requires Intel or Apple Silicon.')
mac_checksums = {
    'arm64': '740288ec6887be94280a5dfa25b5e23a78285cab104519e6c7e218904ee82459',
    'x64': '29ac3ea02be6bd143e824973f2cc5fa74bc4094393a9eaab0ff6814f19dd8522',
}
url = f'https://github.com/ggml-org/llama.cpp/releases/download/b11429/llama-b11429-bin-macos-{architecture}.tar.gz' if mac else model['runtimeUrl']
checksum = mac_checksums[architecture] if mac else model['runtimeSha256']
archive = download(f'llama-b11429-macos-{architecture}.tar.gz' if mac else 'llama-cpu-b11429.zip', url)
if hashlib.sha256(archive.read_bytes()).hexdigest() != checksum:
    raise RuntimeError('llama.cpp checksum mismatch')
dest = root / 'runtime' / 'llama'
dest.mkdir(parents=True, exist_ok=True)
if mac:
    unpacked = root / '.cache' / f'llama-macos-{architecture}-b11429'
    with tarfile.open(archive) as tar:
        tar.extractall(unpacked, filter='data')
    servers = list(unpacked.rglob('llama-server'))
    if len(servers) != 1:
        raise RuntimeError('Expected exactly one llama-server in the macOS archive.')
    # Keep the bin/lib relationship and symlinks used by @rpath dylibs.
    bundle = servers[0].parent.parent if servers[0].parent.name == 'bin' else servers[0].parent
    shutil.copytree(bundle, dest, symlinks=True, dirs_exist_ok=True)
    if servers[0].parent.name == 'bin':
        launcher = dest / 'llama-server'
        launcher.unlink(missing_ok=True)
        launcher.symlink_to('bin/llama-server')
else:
    with zipfile.ZipFile(archive) as z:
        for item in z.infolist():
            name = Path(item.filename).name
            if name.endswith('.dll') or name == 'llama-server.exe':
                with z.open(item) as source, (dest / name).open('wb') as target:
                    shutil.copyfileobj(source, target)
licenses = root / 'resources' / 'licenses'
licenses.mkdir(exist_ok=True)
for name, url in [
    ('llama-cpp-LICENSE.txt', 'https://raw.githubusercontent.com/ggml-org/llama.cpp/b11429/LICENSE'),
    ('HY-MT-LICENSE.txt', model["licenseUrl"]),
]:
    shutil.copy2(download(model['id'] + '-' + name if name == 'HY-MT-LICENSE.txt' else name, url), licenses / name)
print('Official llama.cpp CPU runtime is ready; weights are not bundled.')
