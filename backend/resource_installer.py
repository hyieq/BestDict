"""Explicit, streamed resource installation. Never called during application startup."""
import gzip
import hashlib
import json
import shutil
import sqlite3
import time
import unicodedata
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath


def normalize(word):
    text = unicodedata.normalize('NFKC', word).casefold()
    result = []
    for char in text:
        if 'LATIN' in unicodedata.name(char, ''):
            result.extend(c for c in unicodedata.normalize('NFD', char) if not unicodedata.combining(c) and c.isalnum())
        elif char.isalnum():
            result.append(char)
    return ''.join(result)


def checksum(path, algorithm='sha256'):
    digest = hashlib.new(algorithm)
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def fetch(url, output, emit, resource_id, estimate):
    output.parent.mkdir(parents=True, exist_ok=True)
    partial = output.with_suffix(output.suffix + '.part')
    downloaded = 0
    last_emit = 0
    request = urllib.request.Request(url, headers={'User-Agent': 'BestDict/0.2 optional-resource-download'})
    try:
        with urllib.request.urlopen(request, timeout=60) as source, partial.open('wb') as target:
            total = int(source.headers.get('Content-Length') or estimate or 0)
            while block := source.read(1024 * 1024):
                target.write(block)
                downloaded += len(block)
                if downloaded > 2 * 1024**3:
                    raise ValueError('下载文件超过预期大小，已停止。')
                if time.monotonic() - last_emit > .25:
                    emit({'id': resource_id, 'phase': 'downloading', 'received': downloaded, 'total': total,
                          'message': '正在下载公开数据…'})
                    last_emit = time.monotonic()
        if total and downloaded != total:
            raise ValueError('下载不完整，请重试。')
        partial.replace(output)
    finally:
        partial.unlink(missing_ok=True)


def install_dictionary(assets, library, resource_id, emit, source_file=None):
    catalog = json.loads((assets / 'dictionaries.json').read_text(encoding='utf-8'))
    spec = next((item for item in catalog['dictionaries'] if item['id'] == resource_id), None)
    if not spec:
        raise ValueError('未知词库。')
    source = catalog['source']
    cached = library / 'cache' / 'wiktionary-zh.jsonl.gz'
    if source_file:
        raw = Path(source_file)
    else:
        raw = cached
        if not raw.exists():
            fetch(source['url'], raw, emit, resource_id, source['downloadBytesEstimate'])
    folder = library / resource_id
    folder.mkdir(parents=True, exist_ok=True)
    output = folder / 'dictionary.db'
    temp = folder / 'dictionary.db.building'
    temp.unlink(missing_ok=True)
    conn = sqlite3.connect(temp)
    conn.executescript('''PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;
      CREATE TABLE entries(id INTEGER PRIMARY KEY, word TEXT NOT NULL UNIQUE,
        normalized TEXT NOT NULL, phonetic TEXT, translation TEXT, definition TEXT,
        exchange TEXT, tags TEXT, rank INTEGER NOT NULL);
      CREATE TABLE aliases(normalized TEXT, entry_id INTEGER);
      CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT);
    ''')
    positions = {'noun': 'n.', 'verb': 'v.', 'adj': 'adj.', 'adv': 'adv.', 'pron': 'pron.', 'prep': 'prep.', 'conj': 'conj.', 'intj': 'int.'}
    count = 0
    scanned = 0
    last_emit = 0
    try:
        opener = gzip.open if raw.suffix == '.gz' else open
        with opener(raw, 'rt', encoding='utf-8-sig') as stream:
            for line in stream:
                scanned += 1
                if not line.strip():
                    continue
                row = json.loads(line)
                if row.get('lang_code') != spec['languageCode']:
                    continue
                word = str(row.get('word', '')).strip()
                if not word or len(word) > 100:
                    continue
                glosses = []
                prefix = positions.get(row.get('pos'), '')
                for sense in row.get('senses', []):
                    for gloss in sense.get('glosses', sense.get('raw_glosses', [])):
                        if isinstance(gloss, str) and gloss.strip():
                            glosses.append((prefix + ' ' + gloss.strip()).strip())
                    if not sense.get('glosses'):
                        for related in sense.get('form_of', []) + sense.get('alt_of', []):
                            if isinstance(related, dict) and related.get('word'):
                                glosses.append(f'词形 / 变体：{related["word"]}')
                if not glosses:
                    continue
                phonetic = next((s['ipa'] for s in row.get('sounds', []) if s.get('ipa')), '')
                previous = conn.execute('SELECT id,translation FROM entries WHERE word=?', (word,)).fetchone()
                if previous:
                    definitions = list(dict.fromkeys(previous[1].split('\n') + glosses))
                    conn.execute('UPDATE entries SET translation=? WHERE id=?', ('\n'.join(definitions), previous[0]))
                    entry_id = previous[0]
                else:
                    cursor = conn.execute('INSERT INTO entries(word,normalized,phonetic,translation,definition,exchange,tags,rank) VALUES(?,?,?,?,?,?,?,?)',
                        (word, normalize(word), phonetic, '\n'.join(dict.fromkeys(glosses)), '', '', '', 999999))
                    entry_id = cursor.lastrowid
                    count += 1
                for form in row.get('forms', []):
                    if isinstance(form, dict) and form.get('form') and set(form.get('tags', [])) & {'hiragana', 'katakana', 'romanization'}:
                        conn.execute('INSERT INTO aliases VALUES(?,?)', (normalize(form['form']), entry_id))
                if time.monotonic() - last_emit > .4:
                    emit({'id': resource_id, 'phase': 'indexing', 'count': count, 'message': f'正在建立索引 · {count:,} 词条'})
                    last_emit = time.monotonic()
        if count == 0:
            raise ValueError('文件没有所选语言的有效词条，请导入中文版 Wiktextract JSONL 数据。')
        conn.executescript('CREATE INDEX idx_normalized ON entries(normalized); CREATE INDEX idx_aliases ON aliases(normalized,entry_id);')
        metadata = {**spec, 'source': source['name'], 'license': source['license'], 'licenseUrl': source['licenseUrl'],
                    'homepage': source['homepage'], 'sourceUrl': source['url'], 'attribution': source['attribution'],
                    'count': count, 'format': 'bestdict-sqlite-v1', 'installedAt': time.strftime('%Y-%m-%d'), 'sha256': checksum(raw)}
        conn.executemany('INSERT INTO metadata VALUES(?,?)', [('count', str(count)), ('source', source['name']), ('languageCode', spec['languageCode'])])
        conn.commit()
        conn.close()
        temp.replace(output)
        (folder / 'metadata.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding='utf-8')
        (folder / 'ATTRIBUTION.txt').write_text(source['attribution'] + '\n' + source['license'] + '\n' + source['licenseUrl'] + '\n' + source['url'], encoding='utf-8')
        emit({'id': resource_id, 'phase': 'complete', 'count': count, 'message': '词库已安装，可以选择使用。'})
        return metadata
    finally:
        conn.close()
        temp.unlink(missing_ok=True)


def install_dictionary_pack(assets, library, resource_ids, emit, source_file=None):
    """Read the shared source once; commit each selected language only when valid."""
    catalog = json.loads((assets / 'dictionaries.json').read_text(encoding='utf-8'))
    if not isinstance(resource_ids, list) or len(set(resource_ids)) != len(resource_ids):
        raise ValueError('词库选择无效。')
    specs = [s for s in catalog['dictionaries'] if s['id'] in resource_ids]
    if len(specs) != len(resource_ids):
        raise ValueError('词库选择无效。')
    if not specs:
        return {'ready': True}
    raw = Path(source_file) if source_file else library / 'cache' / 'wiktionary-zh.jsonl.gz'
    source = catalog['source']
    if not raw.exists():
        fetch(source['url'], raw, emit, 'multi-dictionaries', source['downloadBytesEstimate'])
    states = {}
    positions = {'noun': 'n.', 'verb': 'v.', 'adj': 'adj.', 'adv': 'adv.', 'pron': 'pron.', 'prep': 'prep.', 'conj': 'conj.', 'intj': 'int.'}
    try:
        for spec in specs:
            folder = library / spec['id']
            folder.mkdir(parents=True, exist_ok=True)
            temp = folder / 'dictionary.db.building'
            temp.unlink(missing_ok=True)
            conn = sqlite3.connect(temp)
            states[spec['languageCode']] = {'spec': spec, 'conn': conn, 'temp': temp, 'folder': folder, 'count': 0}
            conn.executescript('''PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;
              CREATE TABLE entries(id INTEGER PRIMARY KEY, word TEXT NOT NULL UNIQUE, normalized TEXT NOT NULL,
                phonetic TEXT, translation TEXT, definition TEXT, exchange TEXT, tags TEXT, rank INTEGER NOT NULL);
              CREATE TABLE aliases(normalized TEXT, entry_id INTEGER);
              CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT);''')
        last_emit = 0
        opener = gzip.open if raw.suffix == '.gz' else open
        with opener(raw, 'rt', encoding='utf-8-sig') as stream:
            for line in stream:
                if not line.strip():
                    continue
                row = json.loads(line)
                state = states.get(row.get('lang_code'))
                if not state:
                    continue
                word = str(row.get('word', '')).strip()
                if not word or len(word) > 100:
                    continue
                glosses = []
                prefix = positions.get(row.get('pos'), '')
                for sense in row.get('senses', []):
                    for gloss in sense.get('glosses', sense.get('raw_glosses', [])):
                        if isinstance(gloss, str) and gloss.strip():
                            glosses.append((prefix + ' ' + gloss.strip()).strip())
                    if not sense.get('glosses'):
                        for related in sense.get('form_of', []) + sense.get('alt_of', []):
                            if isinstance(related, dict) and related.get('word'):
                                glosses.append(f'词形 / 变体：{related["word"]}')
                if not glosses:
                    continue
                conn = state['conn']
                previous = conn.execute('SELECT id,translation FROM entries WHERE word=?', (word,)).fetchone()
                if previous:
                    entry_id = previous[0]
                    conn.execute('UPDATE entries SET translation=? WHERE id=?', ('\n'.join(dict.fromkeys(previous[1].split('\n') + glosses)), entry_id))
                else:
                    phonetic = next((s['ipa'] for s in row.get('sounds', []) if s.get('ipa')), '')
                    entry_id = conn.execute('INSERT INTO entries(word,normalized,phonetic,translation,definition,exchange,tags,rank) VALUES(?,?,?,?,?,?,?,?)',
                        (word, normalize(word), phonetic, '\n'.join(dict.fromkeys(glosses)), '', '', '', 999999)).lastrowid
                    state['count'] += 1
                for form in row.get('forms', []):
                    if isinstance(form, dict) and form.get('form') and set(form.get('tags', [])) & {'hiragana', 'katakana', 'romanization'}:
                        conn.execute('INSERT INTO aliases VALUES(?,?)', (normalize(form['form']), entry_id))
                if time.monotonic() - last_emit > .4:
                    count = sum(s['count'] for s in states.values())
                    emit({'id': 'multi-dictionaries', 'phase': 'indexing', 'count': count, 'message': f'正在建立索引 · {count:,} 词条'})
                    last_emit = time.monotonic()
        if any(s['count'] == 0 for s in states.values()):
            raise ValueError('文件没有所选语言的有效词条，请导入中文版 Wiktextract JSONL 数据。')
        fingerprint = checksum(raw)
        for state in states.values():
            conn, spec, folder = state['conn'], state['spec'], state['folder']
            conn.executescript('CREATE INDEX idx_normalized ON entries(normalized); CREATE INDEX idx_aliases ON aliases(normalized,entry_id);')
            conn.executemany('INSERT INTO metadata VALUES(?,?)', [('count', str(state['count'])), ('source', source['name']), ('languageCode', spec['languageCode'])])
            conn.commit()
            conn.close()
            state['temp'].replace(folder / 'dictionary.db')
            metadata = {**spec, 'source': source['name'], 'license': source['license'], 'licenseUrl': source['licenseUrl'],
                'homepage': source['homepage'], 'sourceUrl': source['url'], 'attribution': source['attribution'],
                'count': state['count'], 'format': 'bestdict-sqlite-v1', 'installedAt': time.strftime('%Y-%m-%d'), 'sha256': fingerprint}
            (folder / 'metadata.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding='utf-8')
            (folder / 'ATTRIBUTION.txt').write_text(source['attribution'] + '\n' + source['license'] + '\n' + source['licenseUrl'] + '\n' + source['url'], encoding='utf-8')
        emit({'id': 'multi-dictionaries', 'phase': 'complete', 'message': '多语言词库已安装。'})
        return {'ready': True}
    finally:
        for state in states.values():
            state['conn'].close()
            state['temp'].unlink(missing_ok=True)


def install_kokoro(assets, library, emit, source_file=None):
    import tarfile
    spec = json.loads((assets / 'kokoro-model.json').read_text(encoding='utf-8'))
    folder = library / 'kokoro'
    folder.mkdir(parents=True, exist_ok=True)
    staging = folder / 'model.incoming'
    if staging.resolve().parent != folder.resolve():
        raise ValueError('模型安装路径无效。')
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir()
    archive_file = Path(source_file) if source_file else library / 'cache' / spec['filename']
    try:
        if not source_file and not archive_file.exists():
            fetch(spec['url'], archive_file, emit, 'kokoro', spec['bytes'])
        emit({'id': 'kokoro', 'phase': 'verifying', 'message': '正在验证官方 SHA-256…'})
        if archive_file.stat().st_size != spec['bytes'] or checksum(archive_file) != spec['sha256']:
            if not source_file:
                archive_file.unlink(missing_ok=True)
            raise ValueError('语音包校验失败，请重新下载官方 INT8 中英语音包。')
        emit({'id': 'kokoro', 'phase': 'extracting', 'message': '正在安装离线语音包…'})
        with tarfile.open(archive_file, 'r:bz2') as archive:
            total = 0
            for entry in archive:
                relative = PurePosixPath(entry.name)
                if relative.is_absolute() or '..' in relative.parts or '\\' in entry.name or ':' in entry.name or not relative.parts or relative.parts[0] != spec['directory'] or not (entry.isfile() or entry.isdir()):
                    raise ValueError('语音包包含无效路径。')
                parts = relative.parts[1:]
                if not parts or entry.isdir():
                    continue
                total += entry.size
                if total > 1024**3:
                    raise ValueError('语音包解压大小异常。')
                target = staging.joinpath(*parts)
                if not target.resolve().is_relative_to(staging.resolve()):
                    raise ValueError('语音包包含无效路径。')
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(entry) as source, target.open('wb') as output:
                    shutil.copyfileobj(source, output)
        sizes = {}
        for required in spec['required']:
            target = staging / required
            if not target.is_file() or target.stat().st_size == 0:
                raise ValueError('语音包缺少必要文件。')
            sizes[required] = target.stat().st_size
        output = folder / 'model'
        if output.exists():
            if output.resolve().parent != folder.resolve():
                raise ValueError('模型安装路径无效。')
            shutil.rmtree(output)
        staging.replace(output)
        (folder / 'metadata.json').write_text(json.dumps({'sha256': spec['sha256'], 'sizes': sizes}), encoding='utf-8')
        (folder / 'ATTRIBUTION.txt').write_text('Kokoro-82M v1.1 / hexgrad\nApache-2.0\nhttps://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh\n' + spec['homepage'], encoding='utf-8')
        emit({'id': 'kokoro', 'phase': 'complete', 'message': '离线语音包已安装。'})
        return {'ready': True}
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def install_hy(assets, library, emit, source_file=None):
    spec = json.loads((assets / 'hy-model.json').read_text(encoding='utf-8'))
    folder = library / 'hy-mt2'
    folder.mkdir(parents=True, exist_ok=True)
    output = folder / spec['filename']
    temporary = folder / (spec['filename'] + '.incoming')
    resource_id = 'hy-mt2'
    try:
        if source_file:
            source = Path(source_file)
            if source.stat().st_size != spec['bytes']:
                raise ValueError('请选择官方 Hy-MT2-1.8B-Q4_K_M.gguf 文件。')
            emit({'id': resource_id, 'phase': 'verifying', 'message': '正在校验本地模型…'})
            shutil.copyfile(source, temporary)
        else:
            fetch(spec['url'], temporary, emit, resource_id, spec['bytes'])
        emit({'id': resource_id, 'phase': 'verifying', 'message': '正在验证官方 SHA-256…'})
        if temporary.stat().st_size != spec['bytes'] or checksum(temporary) != spec['sha256']:
            raise ValueError('模型校验失败，请重新下载官方 Q4_K_M 文件。')
        temporary.replace(output)
        shutil.copy2(assets / 'licenses' / 'HY-MT-LICENSE.txt', folder / 'LICENSE.txt')
        (folder / 'metadata.json').write_text(json.dumps({'sha256': spec['sha256'], 'revision': spec['revision'], 'filename': spec['filename']}, indent=2), encoding='utf-8')
        emit({'id': resource_id, 'phase': 'complete', 'message': 'Hy-MT2 已就绪，可切换使用。'})
        return {'ready': True}
    finally:
        temporary.unlink(missing_ok=True)


def install_argos(assets, library, emit, source_file=None):
    """Install both pinned directions atomically, from URLs, two local files or a dev directory."""
    spec = json.loads((assets / 'argos-model.json').read_text(encoding='utf-8'))
    local_archives = None
    if isinstance(source_file, list):
        if len(source_file) != 2:
            raise ValueError('请同时选择中英两个方向的 .argosmodel 文件。')
        expected_sizes = {p['bytes'] for p in spec['packages']}
        local_archives = {}
        for filename in source_file:
            candidate = Path(filename)
            if not candidate.is_file() or candidate.stat().st_size not in expected_sizes:
                raise ValueError('Argos 模型校验失败，请选择官方 1.9 中英模型包。')
            local_archives[checksum(candidate)] = candidate
        if any(p['sha256'] not in local_archives for p in spec['packages']):
            raise ValueError('Argos 模型校验失败，请选择官方 1.9 中英模型包。')
    folder = library / 'argos'
    folder.mkdir(parents=True, exist_ok=True)
    staging = folder / 'models.incoming'
    # These are fixed children of the explicitly chosen resource library.
    if staging.resolve().parent != folder.resolve():
        raise ValueError('模型安装路径无效。')
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir()
    try:
        for package in spec['packages']:
            if local_archives is not None:
                archive_file = local_archives[package['sha256']]
            elif source_file:
                archive_file = Path(source_file) / package['filename']
            else:
                archive_file = library / 'cache' / 'argos' / package['filename']
            emit({'id': 'argos', 'phase': 'verifying', 'message': f"正在准备 {package['pair']} 模型…"})
            if not archive_file.exists():
                if source_file:
                    raise ValueError('模型包不完整，需要中英两个方向。')
                fetch(package['url'], archive_file, emit, 'argos', package['bytes'])
            if archive_file.stat().st_size != package['bytes'] or (local_archives is None and checksum(archive_file) != package['sha256']):
                if not source_file:
                    archive_file.unlink(missing_ok=True)
                raise ValueError('Argos 模型校验失败，请重试下载。')
            emit({'id': 'argos', 'phase': 'extracting', 'message': f"正在安装 {package['pair']} 模型…"})
            destination = staging / package['pair']
            with zipfile.ZipFile(archive_file) as archive:
                unpacked = 0
                for entry in archive.infolist():
                    relative = PurePosixPath(entry.filename)
                    if relative.is_absolute() or '..' in relative.parts or '\\' in entry.filename:
                        raise ValueError('模型包包含无效路径。')
                    parts = relative.parts[1:]
                    if not parts or entry.is_dir() or parts[0] not in ('model', 'sentencepiece.model', 'metadata.json', 'README', 'README.md', 'LICENSE'):
                        continue
                    unpacked += entry.file_size
                    if unpacked > 512 * 1024**2:
                        raise ValueError('模型包解压大小异常。')
                    target = destination.joinpath(*parts)
                    if not target.resolve().is_relative_to(destination.resolve()):
                        raise ValueError('模型包包含无效路径。')
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(entry) as source, target.open('wb') as output:
                        shutil.copyfileobj(source, output)
            for required in ('model/model.bin', 'model/config.json', 'sentencepiece.model'):
                if not (destination / required).is_file() or (destination / required).stat().st_size == 0:
                    raise ValueError('Argos 模型缺少必要文件。')
        output = folder / 'models'
        if output.exists():
            if output.resolve().parent != folder.resolve():
                raise ValueError('模型安装路径无效。')
            shutil.rmtree(output)
        staging.replace(output)
        (folder / 'ATTRIBUTION.txt').write_text('Argos Translate / Helsinki-NLP OPUS-MT\n' + spec['license'] + '\n' + spec['homepage'] + '\n' + spec['licenseUrl'], encoding='utf-8')
        metadata = {'packages': {p['pair']: p['sha256'] for p in spec['packages']}}
        (folder / 'metadata.json').write_text(json.dumps(metadata, indent=2), encoding='utf-8')
        emit({'id': 'argos', 'phase': 'complete', 'message': 'Argos 中英模型已安装，选择后保存设置即可启用。'})
        return {'ready': True}
    finally:
        if staging.exists():
            shutil.rmtree(staging)
