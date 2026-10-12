"""Optional proxy-compatible bootstrap of integrity-checked installer tools."""
import concurrent.futures
import hashlib
import subprocess
import tarfile
import zipfile
from pathlib import Path
from setup_assets import download

ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / '.cache' / 'builder'
JOBS = [
    ('nsis-3.0.4.1', 'nsis-3.0.4.1.7z', '9877df902530f96357d13a7a31ae2b9df67f48b11ffc9a1700a7c961574ec5fa', 'nsis'),
    ('nsis-resources-3.4.1', 'nsis-resources-3.4.1.7z', '593a9a92ef958321293ac6a2ee61e64bf1bd543142a5bd6b3d310709cc924103', 'nsis-resources'),
    ('win-codesign@1.1.0', 'rcedit-windows-2_0_0.zip', 'c66591ebe0919c60231f0bf79ff223e6504bfa69bc13edc1fa8bfc6177b73402', 'rcedit'),
    ('7zip@1.0.0', '7zip-win-x64.tar.gz', 'be071f15bd6da2f78fe81c6ddef2009b0c4d8a51f36b780cb806c7e6df95e1b3', '7zip'),
]


def prepare(job):
    release, name, expected, folder = job
    asset = download(name, f'https://github.com/electron-userland/electron-builder-binaries/releases/download/{release}/{name}')
    if hashlib.sha256(asset.read_bytes()).hexdigest() != expected:
        raise RuntimeError(f'Integrity check failed: {name}')
    dest = TOOLS / folder
    dest.mkdir(parents=True, exist_ok=True)
    if name.endswith('.7z'):
        subprocess.run([str(TOOLS / '7zip' / 'bin' / '7za.exe'), 'x', '-y', '-aoa', f'-o{dest}', str(asset)],
            check=True, stdout=subprocess.DEVNULL, creationflags=0x08000000)
    elif name.endswith('.zip'):
        with zipfile.ZipFile(asset) as archive:
            archive.extractall(dest)
    else:
        with tarfile.open(asset) as archive:
            archive.extractall(TOOLS, filter='data')
    print(f'{folder}: ready (SHA-256 verified)', flush=True)


prepare(JOBS[-1])
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    list(pool.map(prepare, JOBS[:-1]))
