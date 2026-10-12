"""Bundle the small official CPU runner; model weights remain an optional download."""
import hashlib
import json
import shutil
import zipfile
from pathlib import Path
from setup_assets import download

root = Path(__file__).resolve().parents[1]
model = json.loads((root / 'resources/hy-model.json').read_text(encoding='utf-8'))
archive = download('llama-cpu-b11429.zip', model['runtimeUrl'])
if hashlib.sha256(archive.read_bytes()).hexdigest() != model['runtimeSha256']:
    raise RuntimeError('llama.cpp checksum mismatch')
dest = root / 'runtime' / 'llama'
dest.mkdir(parents=True, exist_ok=True)
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
    ('HY-MT-LICENSE.txt', f'https://huggingface.co/tencent/HY-MT1.5-1.8B-GGUF/resolve/{model["revision"]}/License.txt'),
]:
    shutil.copy2(download(name, url), licenses / name)
print('Official llama.cpp CPU runtime is ready; weights are not bundled.')
