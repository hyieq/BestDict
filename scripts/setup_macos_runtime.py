"""Prepare a relocatable Apple Silicon Python; never use the system Python at runtime."""
import platform
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def build_runtime():
    if sys.platform != 'darwin' or platform.machine() != 'arm64':
        raise RuntimeError('The macOS preview currently requires an Apple Silicon runner.')
    managed = ROOT / '.cache' / 'macos-python'
    subprocess.run(['uv', 'python', 'install', '3.12.10', '--install-dir', str(managed), '--no-bin'], check=True)
    candidates = list(managed.glob('cpython-3.12.10-macos-aarch64-*'))
    if len(candidates) != 1:
        raise RuntimeError(f'Expected one standalone Python installation in {managed}')
    target = ROOT / 'runtime' / 'python'
    # Preserve relative symlinks and executable permissions from python-build-standalone.
    shutil.copytree(candidates[0], target, symlinks=True, dirs_exist_ok=True)
    python = target / 'bin' / 'python3'
    subprocess.run(['uv', 'pip', 'install', '--python', str(python), '--target',
                    str(target / 'lib/python3.12/site-packages'), '--only-binary', ':all:',
                    'ctranslate2==4.6.0', 'sentencepiece==0.2.1', 'setuptools==80.9.0',
                    'sherpa-onnx==1.13.8', 'numpy==2.2.6'], check=True)
    subprocess.run([str(python), '-I', '-c',
                    'import sqlite3, ssl, ctranslate2, sentencepiece, sherpa_onnx, numpy'], check=True)


if __name__ == '__main__':
    build_runtime()
