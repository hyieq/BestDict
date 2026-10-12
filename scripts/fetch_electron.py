"""Optional download fallback when Node cannot reach GitHub through a proxy."""
import json
import zipfile
from pathlib import Path
from setup_assets import download

root = Path(__file__).resolve().parents[1]
version = json.loads((root / 'node_modules/electron/package.json').read_text())['version']
name = f'electron-v{version}-win32-x64.zip'
archive = download(name, f'https://github.com/electron/electron/releases/download/v{version}/{name}')
with zipfile.ZipFile(archive) as source:
    source.extractall(root / 'node_modules/electron/dist')
(root / 'node_modules/electron/path.txt').write_text('electron.exe', encoding='utf-8')
print('Electron runtime ready.')
