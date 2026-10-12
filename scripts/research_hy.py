import json
from pathlib import Path
from setup_assets import download

root = Path(__file__).resolve().parents[1]
model = json.loads((root / 'resources/hy-model.json').read_text(encoding='utf-8'))
download(model['filename'], model['url'])
