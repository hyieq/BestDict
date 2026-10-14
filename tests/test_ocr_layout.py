import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from ocr_worker import join_lines, reading_order


def line(text, x, y, width=180):
    return {'text': text, 'box': [[x, y], [x + width, y], [x + width, y + 20], [x, y + 20]]}


class LayoutTests(unittest.TestCase):
    def test_columns_are_read_down_then_across(self):
        lines = [line('Left one', 0, 0), line('Right one', 260, 0), line('left two.', 0, 25), line('right two.', 260, 25)]
        self.assertEqual(join_lines(reading_order(lines)), 'Left one left two.\n\nRight one right two.')

    def test_chinese_wrap_and_paragraphs(self):
        self.assertEqual(join_lines([line('你好', 0, 0), line('世界', 0, 25), line('新段落', 0, 90)]), '你好世界\n\n新段落')

    def test_empty(self):
        self.assertEqual(join_lines(reading_order([])), '')


if __name__ == '__main__':
    unittest.main()
