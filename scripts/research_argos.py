"""Explicit developer download of pinned Argos test archives, never release resources."""
import json
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'backend'))
from resource_installer import checksum, fetch

spec = json.loads((root / 'resources/argos-model.json').read_text(encoding='utf-8'))
for package in spec['packages']:
    output = root / '.cache' / package['filename']
    if not output.exists():
        fetch(package['url'], output, lambda event: print(event['message'], flush=True), 'argos', package['bytes'])
    if output.stat().st_size != package['bytes'] or checksum(output) != package['sha256']:
        raise SystemExit(f'Checksum failed: {output}')
    print(f"Verified {package['filename']}", flush=True)
