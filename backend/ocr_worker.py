"""Memory-only screenshot OCR. Models are installed explicitly by the desktop app."""
import argparse
import base64
import hashlib
import json
import re
import sys
import statistics
from pathlib import Path


def reading_order(lines):
    """Split clear column gutters before sorting rows, preserving common two-column screenshots."""
    if len(lines) < 2:
        return lines
    height = statistics.median(max(1, l['box'][2][1] - l['box'][0][1]) for l in lines)
    for axis, threshold in ((0, height * 1.5), (1, height * 1.2)):
        ordered = sorted(lines, key=lambda l: min(p[axis] for p in l['box']))
        edge = max(p[axis] for p in ordered[0]['box'])
        for i, line in enumerate(ordered[1:], 1):
            start = min(p[axis] for p in line['box'])
            if start - edge > threshold:
                return reading_order(ordered[:i]) + reading_order(ordered[i:])
            edge = max(edge, max(p[axis] for p in line['box']))
    return sorted(lines, key=lambda l: (l['box'][0][1], l['box'][0][0]))


def join_lines(lines):
    """Join wrapped lines conservatively; keep gaps, indents and separate columns."""
    if not lines:
        return ''
    out = lines[0]['text']
    for prev, line in zip(lines, lines[1:]):
        a, b = prev['box'], line['box']
        height = max(1, a[2][1] - a[0][1])
        gap = b[0][1] - a[2][1]
        same_column = abs(b[0][0] - a[0][0]) < height * 1.5
        if not same_column or gap > height * 1.1 or gap < -height * .5:
            separator = '\n\n'
        elif re.search(r'[。！？.!?:：]$', prev['text']):
            separator = '\n'
        else:
            separator = '' if re.search(r'[\u3400-\u9fff]$', prev['text']) and re.match(r'[\u3400-\u9fff]', line['text']) else ' '
        out += separator + line['text']
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--assets', required=True)
    parser.add_argument('--kind')
    args = parser.parse_args()
    engine = None
    for raw in sys.stdin:
        request = {}
        try:
            request = json.loads(raw)
            if request.get('method') != 'recognize':
                raise ValueError('无效 OCR 请求。')
            encoded = request.get('image', '')
            if not isinstance(encoded, str) or len(encoded) > 64 * 1024 * 1024:
                raise ValueError('截图过大，请缩小选区。')
            if engine is None:
                for file in request['files']:
                    data = (Path(args.assets) / file['name']).read_bytes()
                    if hashlib.sha256(data).hexdigest() != file['sha256']:
                        raise ValueError('OCR 模型损坏，请卸载后重新下载。')
                from rapidocr import RapidOCR
                from rapidocr.utils.download_file import DownloadFile
                def offline_only(*args, **kwargs):
                    raise RuntimeError('OCR 所需模型未安装，离线识别不会自动下载。')
                DownloadFile.run = offline_only
                engine = RapidOCR(params={
                    'Det.model_path': str(Path(args.assets) / 'PP-OCRv6_det_small.onnx'),
                    'Rec.model_path': str(Path(args.assets) / 'PP-OCRv6_rec_small.onnx'),
                    'Global.use_cls': False, 'Global.log_level': 'error',
                    'EngineConfig.onnxruntime.intra_op_num_threads': 4,
                    'EngineConfig.onnxruntime.inter_op_num_threads': 1,
                })
            result = engine(base64.b64decode(encoded, validate=True), use_cls=False)
            lines = [{'text': text, 'confidence': float(score), 'box': box.tolist()}
                     for text, score, box in zip(result.txts or [], result.scores or [], result.boxes if result.boxes is not None else [])]
            lines = reading_order(lines)
            text = join_lines(lines)
            if len(text) > 5000:
                raise ValueError('识别文字超过 5,000 字，请缩小选区。')
            response = {'id': request['id'], 'result': {'text': text, 'lines': lines}}
        except Exception as error:
            response = {'id': request.get('id'), 'error': str(error)}
        print(json.dumps(response, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
