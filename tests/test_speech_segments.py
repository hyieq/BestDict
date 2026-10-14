import sys
from pathlib import Path
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from speech_segments import PronunciationWords, split_text


class SpeechSegments(unittest.TestCase):
    def check_text(self, text):
        parts = split_text(text)
        self.assertEqual(''.join(parts), text)
        self.assertTrue(all(part.strip() for part in parts))
        return parts

    def test_short_words_and_sentences_keep_their_context(self):
        for text in ['apple', '你好', 'Please review the report before Friday.', 'Hi. How are you?']:
            self.assertEqual(self.check_text(text), [text])

    def test_long_english_first_clause_is_available_before_the_whole_sentence(self):
        text = ('Before we send the final report to the customer, '
                'we need to confirm the delivery schedule with the team, '
                'review the latest sales figures and check the supporting documents, '
                'and make sure that all remaining questions have been answered clearly.')
        parts = self.check_text(text)
        self.assertEqual(parts[0].strip(), 'Before we send the final report to the customer,')
        self.assertGreater(len(parts), 3)
        for word in ['customer', 'schedule', 'supporting', 'questions']:
            self.assertTrue(any(word in part for part in parts))

    def test_chinese_paragraphs_and_unpunctuated_text_have_bounded_speech_units(self):
        for text in ['请在周五之前审核这份报告。我们需要确认交付时间，检查最新数据，并和团队讨论尚未解决的问题。收集所有人的反馈之后，再准备最终方案并发送给客户。',
                     '这是一段没有标点符号但需要连续朗读的中文内容' * 12]:
            parts = self.check_text(text)
            self.assertGreater(len(parts), 2)
            self.assertLess(len(parts[0]), 35)

    def test_numbers_urls_abbreviations_and_quotes_are_not_split_inside(self):
        text = ('Dr. Smith said, “Please review the U.S. report for 2026/10/14 and the 3.14159% figure, '
                'then visit https://example.com/a.b?x=3.14 to find the supporting documents.”\n'
                '请检查 1,234.56kg 的数据，然后核对其他记录。')
        parts = self.check_text(text)
        for atom in ['Dr.', 'U.S.', '2026/10/14', '3.14159%', 'https://example.com/a.b?x=3.14', '1,234.56kg']:
            self.assertTrue(any(atom in part for part in parts), atom)
        self.assertFalse(any(part.startswith('”') for part in parts))

    def test_small_final_tail_is_retained_and_empty_input_is_empty(self):
        for text in ['one two three four five six seven eight nine ten eleven', '这是一段很长的文本' * 5 + '你好']:
            self.check_text(text)
        self.assertEqual(split_text(' \n '), [])

    def test_unpunctuated_chinese_preserves_pronunciation_words_at_the_limit(self):
        words = PronunciationWords(['银行', '账户', '负责人', '准备'])
        text = '甲' * 15 + '银行账户负责人准备' + '乙' * 30
        parts = split_text(text, 'zh', words)
        self.assertEqual(''.join(parts), text)
        for word in ['银行', '账户', '负责人', '准备']:
            self.assertTrue(any(word in part for part in parts))
        self.assertEqual(parts[0], '甲' * 15)
        compound = '甲' * 18 + '银行'
        source = '  ' + compound + '。后面的内容需要继续朗读。'
        parts = split_text(source, 'zh', PronunciationWords([compound]))
        self.assertEqual(''.join(parts), source)
        self.assertTrue(all(part.strip() for part in parts))
        self.assertTrue(parts[0].endswith('。'))


if __name__ == '__main__':
    unittest.main()
