"""Fetch public assets and build a portable Windows or macOS translation runtime.

Run with the project's .venv Python. No application data is sent anywhere.
"""
import concurrent.futures
import csv
import hashlib
import json
import re
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / '.cache'
ASSETS = ROOT / 'resources'
CACHE.mkdir(exist_ok=True)
ASSETS.mkdir(exist_ok=True)


def download(name, url):
    target = CACHE / name
    if target.exists() and target.stat().st_size:
        return target
    print(f'Downloading {name} …', flush=True)
    for attempt in range(3):
        partial = target.with_suffix('.partial')
        try:
            request = urllib.request.Request(url, headers={'User-Agent': 'BestDict/0.1 asset-setup'})
            with urllib.request.urlopen(request, timeout=90) as response, partial.open('wb') as out:
                shutil.copyfileobj(response, out)
            partial.replace(target)
            print(f'{name}: {target.stat().st_size / 1048576:.1f} MiB', flush=True)
            return target
        except Exception:
            partial.unlink(missing_ok=True)
            if attempt == 2:
                raise
            time.sleep(2)


def build_dictionary(path):
    output = ASSETS / 'dictionary.db'
    if output.exists():
        return
    temp = output.with_suffix('.building')
    temp.unlink(missing_ok=True)
    conn = sqlite3.connect(temp)
    conn.executescript('''
        PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;
        CREATE TABLE entries(id INTEGER PRIMARY KEY, word TEXT NOT NULL COLLATE NOCASE UNIQUE,
          normalized TEXT NOT NULL, phonetic TEXT, translation TEXT, definition TEXT,
          exchange TEXT, tags TEXT, rank INTEGER NOT NULL);
        CREATE TABLE glosses(term TEXT NOT NULL, entry_id INTEGER NOT NULL);
        CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT);
    ''')
    count = 0
    with path.open(encoding='utf-8-sig', newline='') as source:
        for row in csv.DictReader(source):
            word = row['word'].strip()
            if not word:
                continue
            rank = int(row.get('frq') or row.get('bnc') or 999999)
            if rank <= 0:
                rank = 999999
            cursor = conn.execute('INSERT OR IGNORE INTO entries(word,normalized,phonetic,translation,definition,exchange,tags,rank) VALUES(?,?,?,?,?,?,?,?)',
                (word, re.sub(r'[^a-z0-9]', '', word.lower()), row.get('phonetic', ''),
                 row.get('translation', '').replace('\\n', '\n'), row.get('definition', '').replace('\\n', '\n'),
                 row.get('exchange', ''), row.get('tag', ''), rank))
            if not cursor.rowcount:
                continue
            terms = set()
            for term in re.split(r'[\n;,；，、/]+', row.get('translation', '').replace('\\n', '\n')):
                term = re.sub(r'^\s*(?:[a-z]+\.\s*|\[[^]]*\]\s*|【[^】]*】\s*|\([^)]*\)\s*)+', '', term).strip()
                if re.search(r'[\u3400-\u9fff]', term) and 0 < len(term) <= 64:
                    terms.add(term)
            conn.executemany('INSERT INTO glosses VALUES(?,?)', [(term, cursor.lastrowid) for term in terms])
            count += 1
            if count % 100000 == 0:
                print(f'Indexed {count:,} entries', flush=True)
    conn.executescript('CREATE INDEX idx_normalized ON entries(normalized); CREATE INDEX idx_gloss ON glosses(term,entry_id);')
    conn.execute('INSERT INTO metadata VALUES(?,?)', ('count', str(count)))
    conn.execute('INSERT INTO metadata VALUES(?,?)', ('source', 'ECDICT'))
    conn.commit()
    conn.close()
    temp.replace(output)
    print(f'Dictionary ready: {count:,} entries', flush=True)


def build_runtime(path):
    dest = ROOT / 'runtime' / 'python'
    dest.mkdir(parents=True, exist_ok=True)
    if not (dest / 'python.exe').exists():
        with zipfile.ZipFile(path) as archive:
            archive.extractall(dest)
    (dest / 'python312._pth').write_text('python312.zip\n.\nLib/site-packages\nimport site\n', encoding='utf-8')
    if not (dest / 'Lib' / 'site-packages' / 'ctranslate2').exists():
        subprocess.run(['uv', 'pip', 'install', '--python', str(ROOT / '.venv' / 'Scripts' / 'python.exe'),
            '--target', str(dest / 'Lib' / 'site-packages'), 'ctranslate2==4.6.0', 'sentencepiece==0.2.1', 'setuptools==80.9.0'], check=True)
    from setup_tts_runtime import install
    install()
    from setup_ocr_runtime import install as install_ocr
    install_ocr()


def main():
    # Pin downloaded metadata and preserve checksums for reproducible asset auditing.
    jobs = {
        'ecdict.csv': 'https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv',
        'ecdict-LICENSE': 'https://raw.githubusercontent.com/skywind3000/ECDICT/master/LICENSE',
    }
    if sys.platform == 'win32':
        jobs['python-3.12.10-embed-amd64.zip'] = 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip'
    elif sys.platform != 'darwin':
        raise RuntimeError('Runtime preparation supports Windows and macOS only.')
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
        assets = dict(zip(jobs, pool.map(lambda item: download(*item), jobs.items())))
    if sys.platform == 'win32':
        build_runtime(assets['python-3.12.10-embed-amd64.zip'])
    else:
        from setup_macos_runtime import build_runtime as build_macos_runtime
        build_macos_runtime()
    shutil.copy2(assets['ecdict-LICENSE'], ASSETS / 'ECDICT-LICENSE.txt')
    build_dictionary(assets['ecdict.csv'])
    manifest = {name: {'url': jobs[name], 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'bytes': path.stat().st_size}
                for name, path in assets.items()}
    (ASSETS / 'asset-manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    print('Offline assets and portable runtime are ready.', flush=True)


if __name__ == '__main__':
    main()
