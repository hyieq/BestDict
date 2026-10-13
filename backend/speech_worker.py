"""On-demand Kokoro synthesis. JSONL transport; audio never leaves this computer."""
import argparse
import base64
import io
import json
import os
from pathlib import Path
import sys
import wave

parser = argparse.ArgumentParser()
parser.add_argument('--assets', type=Path, required=True)
parser.add_argument('--kind')
args = parser.parse_args()
tts = None
accent = None


def synthesize(request):
    global tts, accent
    text = request['text']
    if not isinstance(text, str) or not text.strip() or len(text) > 10000:
        raise ValueError('发音文本过长或为空。')
    voice = request['voice']
    rate = request['rate']
    if voice not in (0, 1, 2, 3, 58) or not .5 <= rate <= 2:
        raise ValueError('发音设置无效。')
    import numpy as np
    try:
        import sherpa_onnx
    except ImportError as error:
        raise ValueError('离线语音运行库缺失，请重新安装完整版本。') from error
    english = 'gb' if voice == 2 else 'us'
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
    audio = tts.generate(text=text, sid=voice, speed=rate)
    samples = np.asarray(audio.samples)
    if not samples.size:
        raise ValueError('这段文本未生成可播放的音频。')
    output = io.BytesIO()
    with wave.open(output, 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(audio.sample_rate)
        wav.writeframes((np.clip(samples, -1, 1) * 32767).astype('<i2').tobytes())
    return {'audio': base64.b64encode(output.getvalue()).decode('ascii'), 'engine': 'kokoro'}


for raw in sys.stdin:
    request = {}
    try:
        request = json.loads(raw)
        if request.get('method') != 'synthesize':
            raise ValueError('Unknown speech request')
        print(json.dumps({'id': request.get('id'), 'result': synthesize(request)}), flush=True)
    except Exception as error:
        print(json.dumps({'id': request.get('id'), 'error': str(error)}, ensure_ascii=False), flush=True)
