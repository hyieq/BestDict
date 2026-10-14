from pathlib import Path
import shutil

root = Path(__file__).resolve().parents[1]
for package in ('react', 'react-dom', 'lucide-react'):
    for filename in ('LICENSE', 'LICENSE.md', 'LICENSE.txt'):
        source = root / 'node_modules' / package / filename
        if source.exists():
            shutil.copy2(source, root / 'resources' / f'{package}-LICENSE.txt')
            break
    else:
        raise RuntimeError(f'License file missing for {package}')
print('Renderer licenses preserved.')
speech_license = root / 'runtime/python/Lib/site-packages/sherpa_onnx-1.13.8.dist-info/licenses/LICENSE'
if speech_license.exists():
    shutil.copy2(speech_license, root / 'resources/licenses/sherpa-onnx-LICENSE.txt')

ocr_licenses = root / 'runtime/python/Lib/site-packages/rapidocr-3.10.0.dist-info/licenses'
for filename in ('LICENSE', 'MODEL_LICENSES.md'):
    if (ocr_licenses / filename).exists():
        shutil.copy2(ocr_licenses / filename, root / 'resources/licenses' / ('RapidOCR-' + filename))
