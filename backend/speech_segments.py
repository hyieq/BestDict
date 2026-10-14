"""Small natural speech units; preserve the original text and indivisible tokens."""
import re
from typing import NamedTuple

# A word, URL or number is indivisible. CJK characters can supply fallback boundaries
# when a paragraph has no punctuation; prefer its natural clauses whenever possible.
TOKENS = re.compile(r'https?://[^\s]+|[A-Za-zÀ-ɏ]+(?:[\'’./-][A-Za-zÀ-ɏ]+)*\.?|\d+(?:[.,:/-]\d+)*(?:[A-Za-z%‰℃°]+)?|[^\s]')
ABBREVIATIONS = {'mr.', 'mrs.', 'ms.', 'dr.', 'prof.', 'sr.', 'jr.', 'st.', 'vs.', 'etc.', 'e.g.', 'i.e.'}


class Token(NamedTuple):
    start: int
    end: int
    value: str


class PronunciationWords:
    def __init__(self, words):
        self.words = {word for word in words if len(word) > 1 and all('\u4e00' <= char <= '\u9fff' for char in word)}
        self.maximum = max(map(len, self.words), default=1)

    @classmethod
    def from_file(cls, path):
        with path.open(encoding='utf-8') as source:
            return cls(line.split(maxsplit=1)[0] for line in source if line.strip())

    def end_at(self, text, start):
        for length in range(min(self.maximum, len(text) - start), 1, -1):
            if text[start:start + length] in self.words:
                return start + length
        return start + 1


def split_text(text, language=None, pronunciation_words=None):
    tokens, consumed = [], 0
    for match in TOKENS.finditer(text):
        if match.start() < consumed:
            continue
        end = match.end()
        if pronunciation_words and '\u4e00' <= match.group()[0] <= '\u9fff':
            end = pronunciation_words.end_at(text, match.start())
        tokens.append(Token(match.start(), end, text[match.start():end]))
        consumed = end
    if not tokens:
        return []
    costs = [2.5 if re.match(r'[A-Za-zÀ-ɏ0-9]', token.value) else (len(token.value) if token.value.isalnum() else 0) for token in tokens]
    chinese = language == 'zh' or (language is None and sum(len(token.value) for token in tokens if '\u4e00' <= token.value[0] <= '\u9fff') > sum(cost == 2.5 for cost in costs) * 2)
    segments, start, weight, last_boundary = [], 0, 0, None
    for index, token in enumerate(tokens):
        if token.start < start:
            continue
        value = token.value
        cost = costs[index]
        limit = (16 if not segments else 20) if chinese else (25 if not segments else 30)
        if cost and weight and weight + cost > limit and token.start > start:
            cut, first = last_boundary or (token.start, index)
            segments.append(text[start:cut])
            start = cut
            # Account for the words after the chosen punctuation boundary.
            weight = sum(costs[first:index])
            last_boundary = None
        weight += cost
        next_start = tokens[index + 1].start if index + 1 < len(tokens) else len(text)
        terminal = value[-1:] in '.!?。！？;；,，:：'
        if value.lower() in ABBREVIATIONS or re.fullmatch(r'(?:[A-Za-z]\.){2,}', value):
            terminal = False
        if re.match(r'\d|https?://', value):
            terminal = False
        if terminal or '\n' in text[token.end:next_start]:
            following = index + 1
            while following < len(tokens) and tokens[following].value in '\"\'”’」』）)]':
                following += 1
            next_start = tokens[following].start if following < len(tokens) else len(text)
            last_boundary = (next_start, following)
            if weight >= 8:
                segments.append(text[start:next_start])
                start, weight, last_boundary = next_start, 0, None
    if start < len(text):
        segments.append(text[start:])
    # Avoid a tiny final tail, whose extra inference is longer than its audio.
    if len(segments) > 1 and len(TOKENS.findall(segments[-1])) < 3:
        tail = segments.pop()
        segments[-1] += tail
    return segments
