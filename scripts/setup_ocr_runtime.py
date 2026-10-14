"""Install CPU OCR dependencies; weights are excluded by electron-builder."""
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def install():
    subprocess.run(['uv', 'pip', 'install', '--python', str(ROOT / '.venv/Scripts/python.exe'),
                    '--target', str(ROOT / 'runtime/python/Lib/site-packages'),
                    'rapidocr==3.10.0', 'onnxruntime==1.23.2', 'opencv-python-headless==5.0.0.93'], check=True)


if __name__ == '__main__':
    install()
