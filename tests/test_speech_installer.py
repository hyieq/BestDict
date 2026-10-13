import hashlib
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from resource_installer import install_kokoro


class SpeechInstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='bestdict-tts-test-')
        self.root = Path(self.temp.name)
        self.assets = self.root / 'assets'
        self.assets.mkdir()
        self.library = self.root / 'library'
        self.spec = {'directory': 'kokoro-test', 'filename': 'test.tar.bz2', 'required': ['model.int8.onnx'],
                     'homepage': 'https://example.invalid', 'url': 'https://example.invalid'}

    def tearDown(self):
        self.temp.cleanup()

    def archive(self, name='kokoro-test/model.int8.onnx', symlink=False):
        filename = self.root / 'test.tar.bz2'
        with tarfile.open(filename, 'w:bz2') as archive:
            entry = tarfile.TarInfo(name)
            if symlink:
                entry.type = tarfile.SYMTYPE
                entry.linkname = '../../outside'
                archive.addfile(entry)
            else:
                entry.size = 5
                archive.addfile(entry, io.BytesIO(b'model'))
        self.spec.update(bytes=filename.stat().st_size, sha256=hashlib.sha256(filename.read_bytes()).hexdigest())
        (self.assets / 'kokoro-model.json').write_text(json.dumps(self.spec), encoding='utf-8')
        return filename

    def test_install_verified_archive_and_reject_corruption(self):
        filename = self.archive()
        install_kokoro(self.assets, self.library, lambda _: None, str(filename))
        installed = self.library / 'kokoro/model/model.int8.onnx'
        self.assertEqual(installed.read_bytes(), b'model')
        filename.write_bytes(b'wrong')
        with self.assertRaisesRegex(ValueError, '校验失败'):
            install_kokoro(self.assets, self.library, lambda _: None, str(filename))
        self.assertEqual(installed.read_bytes(), b'model')
        self.assertFalse((self.library / 'kokoro/model.incoming').exists())

    def test_no_path_escape_or_symlink_even_in_a_checksummed_archive(self):
        for name, symlink in [('kokoro-test/../../outside', False), ('/absolute', False),
                              ('kokoro-test/C:/escape', False), ('kokoro-test/model.int8.onnx', True)]:
            with self.subTest(name=name, symlink=symlink):
                filename = self.archive(name, symlink)
                with self.assertRaisesRegex(ValueError, '无效路径'):
                    install_kokoro(self.assets, self.library, lambda _: None, str(filename))
                self.assertFalse((self.library / 'kokoro/metadata.json').exists())
                self.assertFalse((self.library / 'kokoro/model.incoming').exists())


if __name__ == '__main__':
    unittest.main()
