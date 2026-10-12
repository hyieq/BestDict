"""Prepare real-data QA files, outside resources/ and outside the release bundle."""
import json
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'backend'))
from resource_installer import install_dictionary, install_hy, install_argos

assets = root / 'resources'
library = root / '.cache' / 'validation-library'
raw = root / '.cache' / 'wiktionary-zh.jsonl.gz'
model = root / '.cache' / 'HY-MT1.5-1.8B-Q4_K_M.gguf'
if not raw.exists() or not model.exists():
    raise SystemExit('Run scripts/research_dictionary.py and scripts/research_hy.py first.')


def emit(progress):
    if progress['phase'] in ('complete', 'verifying'):
        print(json.dumps(progress, ensure_ascii=False), flush=True)


catalog = json.loads((assets / 'dictionaries.json').read_text(encoding='utf-8'))
for item in catalog['dictionaries']:
    if not (library / item['id'] / 'metadata.json').exists():
        install_dictionary(assets, library, item['id'], emit, str(raw))
if not (library / 'hy-mt1.5' / 'metadata.json').exists():
    install_hy(assets, library, emit, str(model))
if not (library / 'argos' / 'metadata.json').exists():
    install_argos(assets, library, emit, str(root / '.cache'))
