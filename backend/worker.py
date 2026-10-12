"""Isolated JSON-lines worker. Two instances keep lookups independent of inference."""
import argparse
import difflib
import json
import os
import re
import sqlite3
import sys
from collections import OrderedDict
from pathlib import Path

# The Windows embeddable runtime intentionally excludes the script folder from _pth.
sys.path.insert(0, str(Path(__file__).resolve().parent))

sys.stdin.reconfigure(encoding='utf-8')
sys.stdout.reconfigure(encoding='utf-8', line_buffering=True)
sys.stderr.reconfigure(encoding='utf-8')
parser = argparse.ArgumentParser()
parser.add_argument('--assets', type=Path, required=True)
parser.add_argument('--kind', choices=['dictionary', 'translation', 'installer'], required=True)
args = parser.parse_args()
connection = None
connection_path = None
engine = None
engine_pair = None
tokenizer = None
cache = OrderedDict()


def dictionary(database=None):
    global connection, connection_path
    desired = Path(database) if database else args.assets / 'dictionary.db'
    if connection is None or connection_path != desired:
        if connection is not None:
            connection.close()
        location = desired.resolve().as_uri()
        connection = sqlite3.connect(location + '?mode=ro&immutable=1', uri=True)
        connection.row_factory = sqlite3.Row
        connection_path = desired
    return connection


def entry(row):
    return dict(row)


def lookup(query, database=None):
    db = dictionary(database)
    q = query.strip().lower()
    if not q or len(q) > 100:
        return {'entries': [], 'exact': False, 'corrected': False}
    if database:
        from resource_installer import normalize
        normalized = normalize(q)
        if not normalized:
            return {'entries': [], 'exact': False, 'corrected': False}
        rows = db.execute('''SELECT * FROM entries WHERE normalized>=? AND normalized<?
            ORDER BY CASE WHEN normalized=? THEN 0 ELSE 1 END,LENGTH(word),word LIMIT 12''',
            (normalized, normalized + '\U0010ffff', normalized)).fetchall()
        if not rows:
            rows = db.execute('''SELECT DISTINCT e.* FROM aliases a JOIN entries e ON e.id=a.entry_id
                WHERE a.normalized>=? AND a.normalized<? ORDER BY LENGTH(e.word) LIMIT 12''',
                (normalized, normalized + '\U0010ffff')).fetchall()
        return {'entries': [entry(r) for r in rows], 'exact': bool(rows and normalize(rows[0]['word']) == normalized), 'corrected': False}
    chinese = bool(re.search(r'[\u3400-\u9fff]', q))
    if chinese:
        rows = db.execute('''SELECT e.*, MIN(CASE WHEN g.term=? THEN 0 ELSE 1 END) AS match_rank
            FROM (SELECT term, entry_id FROM glosses WHERE term>=? AND term<? ORDER BY term LIMIT 1500) g
            JOIN entries e ON e.id=g.entry_id GROUP BY e.id ORDER BY match_rank,e.rank,LENGTH(e.word) LIMIT 12''',
            (q, q, q + '\uffff')).fetchall()
        return {'entries': [entry(r) for r in rows], 'exact': bool(rows and rows[0]['match_rank'] == 0), 'corrected': False}
    rows = db.execute('''SELECT * FROM entries WHERE word>=? COLLATE NOCASE AND word<? COLLATE NOCASE
        ORDER BY CASE WHEN word=? COLLATE NOCASE THEN 0 ELSE 1 END,rank,LENGTH(word) LIMIT 12''', (q, q + '\uffff', q)).fetchall()
    exact = bool(rows and rows[0]['word'].lower() == q)
    if not exact:
        normalized = re.sub(r'[^a-z0-9]', '', q)
        if normalized:
            alternatives = db.execute('SELECT * FROM entries WHERE normalized=? ORDER BY rank LIMIT 4', (normalized,)).fetchall()
            rows = alternatives + [r for r in rows if r['id'] not in {a['id'] for a in alternatives}]
    corrected = False
    if not rows and q.isascii() and q.isalpha() and len(q) >= 3:
        # Indexed prefix bounds keep typo matching bounded; no full-dictionary scan.
        candidates = db.execute('SELECT * FROM entries WHERE word>=? AND word<? ORDER BY rank LIMIT 2000', (q[0], q[0] + '\uffff')).fetchall()
        close = difflib.get_close_matches(q, [r['word'] for r in candidates], n=6, cutoff=0.74)
        mapping = {r['word']: r for r in candidates}
        rows = [mapping[word] for word in close]
        corrected = bool(rows)
    return {'entries': [entry(r) for r in rows[:12]], 'exact': exact, 'corrected': corrected}


def lookup_all(query, dictionaries, preferred):
    results = []
    for spec in dictionaries:
        result = lookup(query, spec.get('database'))
        if not result['entries']:
            continue
        # A literal headword is stronger evidence than a reverse Chinese gloss.
        literal = any(e['word'].casefold() == query.strip().casefold() for e in result['entries'])
        score = (int(literal), int(result['exact']), int(not result['corrected']), int(spec['id'] == preferred))
        for e in result['entries']:
            e['dictionaryId'] = spec['id']
        results.append((score, spec['id'], result))
    if not results:
        return {'entries': [], 'exact': False, 'corrected': False, 'dictionaryId': preferred}
    results.sort(key=lambda item: item[0], reverse=True)
    _, selected_id, selected = results[0]
    entries = [e for e in selected['entries'] if e['word'].casefold() == query.strip().casefold()]
    suggestions = [e for e in selected['entries'] if e not in entries]
    # Retain ambiguous exact matches, with provenance, without mixing unrelated suggestions.
    for _, _, other in results[1:]:
        if other['exact']:
            entries = entries + [e for e in other['entries'] if e['word'].casefold() == query.strip().casefold()]
    return {**selected, 'entries': (entries + suggestions)[:24], 'dictionaryId': selected_id}


def get_engine(pair):
    global engine, engine_pair, tokenizer
    if engine_pair != pair:
        import ctranslate2
        import sentencepiece
        folder = args.assets / 'models' / pair
        # Keep only the active direction resident. Dictionary use never loads a model.
        engine = None
        tokenizer = None
        engine_pair = None
        engine = ctranslate2.Translator(str(folder / 'model'), device='cpu', compute_type='int8',
            intra_threads=min(4, os.cpu_count() or 2), inter_threads=1)
        tokenizer = sentencepiece.SentencePieceProcessor(model_file=str(folder / 'sentencepiece.model'))
        engine_pair = pair
    return engine, tokenizer


def translate(text, direction):
    if not text.strip():
        return {'text': '', 'direction': direction, 'cached': False}
    if len(text) > 5000:
        raise ValueError('请将文本缩短至 5,000 个字符以内。')
    if direction == 'auto':
        direction = 'zh-en' if re.search(r'[\u3400-\u9fff]', text) else 'en-zh'
    if direction not in ('en-zh', 'zh-en'):
        raise ValueError('不支持的翻译方向。')
    key = (direction, text)
    if key in cache:
        cache.move_to_end(key)
        return {'text': cache[key], 'direction': direction, 'cached': True}
    translator, sp = get_engine(direction.replace('-', '_'))
    outputs = []
    for line in text.split('\n'):
        if not line.strip():
            outputs.append('')
            continue
        sentences = [s.strip() for s in re.split(r'(?<=[。！？!?])\s*|(?<=\.)\s+(?=[A-Z])', line) if s.strip()]
        tokens = []
        for sentence in sentences:
            pieces = sp.encode(sentence, out_type=str)
            # Never silently truncate long inputs; translate all pieces in bounded chunks.
            tokens.extend(pieces[i:i + 384] for i in range(0, len(pieces), 384))
        results = translator.translate_batch(tokens, beam_size=4, max_input_length=0,
            max_decoding_length=768, repetition_penalty=1.05, replace_unknowns=True)
        decoded = [sp.decode(result.hypotheses[0]).replace('\u2581', ' ').strip() for result in results]
        outputs.append(('' if direction == 'en-zh' else ' ').join(decoded))
    result = '\n'.join(outputs)
    cache[key] = result
    if len(cache) > 128:
        cache.popitem(last=False)
    return {'text': result, 'direction': direction, 'cached': False}


def dispatch(request):
    method = request.get('method')
    if method == 'install' and args.kind == 'installer':
        from resource_installer import install_dictionary, install_hy, install_argos
        def emit(progress):
            print(json.dumps({'event': 'progress', 'data': progress}, ensure_ascii=False))
        library = Path(request['library'])
        if request['resourceId'] == 'argos':
            return install_argos(args.assets, library, emit, request.get('sourceFile'))
        if request['resourceId'] == 'hy-mt1.5':
            return install_hy(args.assets, library, emit, request.get('sourceFile'))
        return install_dictionary(args.assets, library, request['resourceId'], emit, request.get('sourceFile'))
    if method == 'status':
        if args.kind == 'dictionary':
            row = dictionary(request.get('database')).execute("SELECT value FROM metadata WHERE key='count'").fetchone()
            return {'count': int(row[0]), 'source': 'ECDICT'}
        return {'ready': all((args.assets / 'models' / pair / 'model' / 'model.bin').exists() for pair in ('en_zh', 'zh_en'))}
    if method == 'lookup' and args.kind == 'dictionary':
        return lookup(str(request.get('text', '')), request.get('database'))
    if method == 'lookup_all' and args.kind == 'dictionary':
        return lookup_all(str(request.get('text', '')), request['dictionaries'], request['preferred'])
    if method == 'translate' and args.kind == 'translation':
        return translate(str(request.get('text', '')), request.get('direction', 'auto'))
    raise ValueError('Unknown worker request')


for raw in sys.stdin:
    request = {}
    try:
        request = json.loads(raw)
        result = dispatch(request)
        print(json.dumps({'id': request.get('id'), 'result': result}, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'id': request.get('id'), 'error': str(error)}, ensure_ascii=False))
