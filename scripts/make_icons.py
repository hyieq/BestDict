"""Encode the supplied BestDict artwork into application and multi-resolution ICO assets."""
from pathlib import Path
from PIL import Image, ImageOps

root = Path(__file__).resolve().parents[1]
art = Image.open(root / 'resources/branding/app-icon-source.png').convert('RGBA')
square = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
contained = ImageOps.contain(art, (1024, 1024), Image.Resampling.LANCZOS)
square.alpha_composite(contained, ((1024 - contained.width) // 2, (1024 - contained.height) // 2))
icon = square.resize((256, 256), Image.Resampling.LANCZOS)
icon.save(root / 'resources/icon.png')
icon.save(root / 'resources/icon.ico', sizes=[(16, 16), (20, 20), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
square.save(root / 'resources/icon.icns')
(root / 'src/assets').mkdir(exist_ok=True)
icon.save(root / 'src/assets/app-icon.png')
icon.save(root / 'docs/assets/logo.png')
print('Supplied artwork encoded as transparent PNG, 8-resolution Windows ICO and macOS ICNS.')
