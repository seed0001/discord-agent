"""Voice-reply chunking — run with:  python -m unittest tests.test_tts -v

Guards the truncation bug: a multi-paragraph reply used to be hard-sliced
(2000 chars for Fish, 800 for edge-tts) and the remainder was never spoken.
"""
import re
import unittest

import tts


class SplitForTtsTest(unittest.TestCase):
    def test_short_text_stays_one_chunk(self):
        self.assertEqual(tts.split_for_tts("Just one line.", 100), ["Just one line."])

    def test_keeps_every_word_of_a_multi_paragraph_reply(self):
        para = "This is a sentence that carries some real weight. "
        text = para * 20 + "\n\n" + para * 20
        chunks = tts.split_for_tts(text, 700)
        self.assertGreater(len(chunks), 1, "should split rather than truncate")
        spoken = re.sub(r"\s+", " ", " ".join(chunks)).strip()
        original = re.sub(r"\s+", " ", text).strip()
        self.assertEqual(spoken, original)

    def test_no_chunk_exceeds_the_limit(self):
        text = " ".join(f"Sentence number {i} here." for i in range(40))
        for chunk in tts.split_for_tts(text, 120):
            self.assertLessEqual(len(chunk), 120)

    def test_hard_splits_a_sentence_longer_than_the_limit(self):
        chunks = tts.split_for_tts("x" * 250, 100)
        self.assertEqual([len(c) for c in chunks], [100, 100, 50])

    def test_empty_text_yields_no_chunks(self):
        self.assertEqual(tts.split_for_tts("", 100), [])
        self.assertEqual(tts.split_for_tts("   \n\n  ", 100), [])


if __name__ == "__main__":
    unittest.main()
