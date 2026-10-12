"""Bundle app-local Microsoft CRT DLLs from the installed VS redistributable."""
import os
import shutil
from pathlib import Path

root = Path(__file__).resolve().parents[1]
override = os.environ.get('BESTDICT_VC_REDIST_DIR')
if override:
    candidates = [Path(override)]
else:
    base = Path(os.environ.get('ProgramFiles', r'C:\Program Files')) / 'Microsoft Visual Studio'
    candidates = sorted(base.glob('*/*/VC/Redist/MSVC/*/x64/Microsoft.VC*.CRT'))
if not candidates:
    raise RuntimeError('未找到 Visual C++ x64 可再分发文件。请设置 BESTDICT_VC_REDIST_DIR 到 Microsoft.VC*.CRT 目录。')
source = candidates[-1]
dest = root / 'runtime' / 'python'
dest.mkdir(parents=True, exist_ok=True)
for output in (dest, root / 'runtime' / 'llama'):
    output.mkdir(parents=True, exist_ok=True)
    for library in source.glob('*.dll'):
        shutil.copy2(library, output / library.name)
print(f'App-local Visual C++ runtime copied from {source}')
