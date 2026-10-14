"""Reusable Kokoro standby and synthesis. JSONL transport stays on this computer."""
import argparse
import base64
import io
import json
import os
from pathlib import Path
import sys
import wave
from time import perf_counter, sleep
# Windows embeddable Python excludes the script directory from its default path.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from speech_segments import PronunciationWords, split_text

parser = argparse.ArgumentParser()
parser.add_argument('--assets', type=Path, required=True)
parser.add_argument('--kind')
args = parser.parse_args()
tts = None
accent = None
load_timings = {}
pronunciation_words = None


def load_model(voice, english_voice=None):
    global tts, accent, pronunciation_words
    if voice not in (0, 1, 2, 3, 58):
        raise ValueError('发音设置无效。')
    started = perf_counter()
    try:
        import sherpa_onnx
    except ImportError as error:
        raise ValueError('离线语音运行库缺失，请重新安装完整版本。') from error
    imported = perf_counter()
    english = 'gb' if voice == 2 or (voice in (3, 58) and english_voice == 2) else 'us'
    if tts is None or accent != english:
        tts = None
        model = args.assets
        config = sherpa_onnx.OfflineTtsConfig(model=sherpa_onnx.OfflineTtsModelConfig(
            kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
                model=str(model / 'model.int8.onnx'), voices=str(model / 'voices.bin'),
                tokens=str(model / 'tokens.txt'), data_dir=str(model / 'espeak-ng-data'),
                lexicon=','.join(str(model / p) for p in (f'lexicon-{english}-en.txt', 'lexicon-zh.txt'))),
            num_threads=min(4, os.cpu_count() or 2)), max_num_sentences=1)
        tts = sherpa_onnx.OfflineTts(config)
        accent = english
    if pronunciation_words is None:
        pronunciation_words = PronunciationWords.from_file(args.assets / 'lexicon-zh.txt')
    load_timings.update(importsMs=(imported - started) * 1000, modelLoadMs=(perf_counter() - imported) * 1000)
    return tts


def wav_audio(pcm, sample_rate):
    output = io.BytesIO()
    with wave.open(output, 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm)
    return base64.b64encode(output.getvalue()).decode('ascii')


def synthesize(request):
    text = request['text']
    if not isinstance(text, str) or not text.strip() or len(text) > 10000:
        raise ValueError('发音文本过长或为空。')
    voice = request['voice']
    rate = request['rate']
    if voice not in (0, 1, 2, 3, 58) or not .5 <= rate <= 2:
        raise ValueError('发音设置无效。')
    started = perf_counter()
    import numpy as np
    numpy_imported = perf_counter()
    tts = load_model(voice, request.get('englishVoice'))
    loaded = perf_counter()
    segments = split_text(text, request.get('language'), pronunciation_words)
    streaming = request.get('stream') and len(segments) > 1
    pcm_parts, sequence = [], 0
    previous = perf_counter()
    first_emitted, produced_seconds = None, 0

    def receive(samples, progress):
        nonlocal sequence, previous, first_emitted, produced_seconds
        if not len(samples):
            return 1
        pcm = (np.clip(samples, -1, 1) * 32767).astype('<i2').tobytes()
        pcm_parts.append(pcm)
        if streaming:
            now = perf_counter()
            print(json.dumps({'id': request.get('id'), 'event': 'audio', 'data': {
                'sequence': sequence, 'pcm': base64.b64encode(pcm).decode('ascii'),
                'sampleRate': tts.sample_rate, 'generationMs': (now - previous) * 1000}}), flush=True)
            previous = now
            sequence += 1
            if first_emitted is None:
                first_emitted = now
            produced_seconds += len(pcm) / 2 / tts.sample_rate
            # Keep a modest lead over playback rather than scheduling an entire
            # long article in the renderer. The first chunk is always sent first.
            lead = produced_seconds - (perf_counter() - first_emitted)
            if lead > 8:
                sleep(lead - 8)
        return 1

    for segment in segments:
        tts.generate(text=segment, sid=voice, speed=rate, callback=receive)
    generated = perf_counter()
    if not pcm_parts:
        raise ValueError('这段文本未生成可播放的音频。')
    result = {'audio': wav_audio(b''.join(pcm_parts), tts.sample_rate), 'engine': 'kokoro', 'streamed': bool(streaming)}
    if request.get('_profile'):
        result['profile'] = {**load_timings, 'importsMs': load_timings['importsMs'] + (numpy_imported - started) * 1000,
                             'generateMs': (generated - loaded) * 1000, 'wavMs': (perf_counter() - generated) * 1000}
    return result


for raw in sys.stdin:
    request = {}
    try:
        request = json.loads(raw)
        if request.get('method') == 'prepare':
            load_model(request['voice'])
            result = {'ready': True}
            if request.get('_profile'):
                result['profile'] = dict(load_timings)
        elif request.get('method') == 'synthesize':
            result = synthesize(request)
        else:
            raise ValueError('Unknown speech request')
        print(json.dumps({'id': request.get('id'), 'result': result}), flush=True)
    except Exception as error:
        print(json.dumps({'id': request.get('id'), 'error': str(error)}, ensure_ascii=False), flush=True)
