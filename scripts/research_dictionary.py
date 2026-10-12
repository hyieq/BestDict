"""Developer-only source verification. Assets remain outside the release bundle."""
import json
from pathlib import Path
from setup_assets import download

root = Path(__file__).resolve().parents[1]
catalog = json.loads((root / 'resources/dictionaries.json').read_text(encoding='utf-8'))
download('wiktionary-zh.jsonl.gz', catalog['source']['url'])
