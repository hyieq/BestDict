"""Validate a relocated preview app without touching any installed user configuration."""
import os
from pathlib import Path
import subprocess
import sys


def verify(app):
    app = app.resolve(strict=True)
    resources = app / 'Contents/Resources'
    subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True)
    for file in resources.rglob('*'):
        if file.is_symlink() and not file.resolve(strict=True).is_relative_to(app):
            raise RuntimeError(f'Bundle has an external symlink: {file}')
        if file.is_file() and (file.suffix.lower() in {'.gguf', '.argosmodel', '.onnx'} or file.name == 'model.bin'):
            raise RuntimeError(f'Optional model weights were bundled: {file}')
    env = {key: value for key, value in os.environ.items() if key not in {'PYTHONHOME', 'PYTHONPATH', 'VIRTUAL_ENV'}}
    python = resources / 'python/bin/python3'
    code = ('import sys, pathlib, sqlite3, ssl, ctranslate2, sentencepiece, sherpa_onnx, numpy; '
            'root=pathlib.Path(sys.argv[1]).resolve(); '
            'assert pathlib.Path(sys.prefix).resolve().is_relative_to(root); '
            'db=sqlite3.connect((root / "assets/dictionary.db").as_uri()+"?mode=ro", uri=True); '
            'assert db.execute("select count(*) from entries").fetchone()[0] > 700000; '
            'print("Relocated Python, native modules and dictionary verified")')
    subprocess.run([str(python), '-I', '-c', code, str(resources)], env=env, cwd=app.parent, check=True)
    subprocess.run([str(resources / 'llama/llama-server'), '--version'], env=env, cwd=app.parent, check=True, timeout=30)


if __name__ == '__main__':
    if sys.platform != 'darwin':
        raise RuntimeError('Bundle verification must run on macOS.')
    verify(Path(sys.argv[1]))
