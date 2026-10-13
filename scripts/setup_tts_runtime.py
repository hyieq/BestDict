"""Install the pinned CPU speech runtime, without downloading voice models."""
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def install():
    if sys.platform == 'win32':
        python = ROOT / '.venv' / 'Scripts' / 'python.exe'
        target = ROOT / 'runtime' / 'python' / 'Lib' / 'site-packages'
        subprocess.run(['uv', 'pip', 'install', '--python', str(python), '--target', str(target),
                        'sherpa-onnx==1.13.8'], check=True)
    else:
        # Invoke on the target platform so its native wheel is selected.
        python = ROOT / 'runtime' / 'python' / 'bin' / 'python3'
        subprocess.run(['uv', 'pip', 'install', '--python', str(python), 'sherpa-onnx==1.13.8', 'numpy'], check=True)


if __name__ == '__main__':
    install()
