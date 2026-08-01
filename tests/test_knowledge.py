"""Tests for knowledge.py — Max's procedural "how to do X" memory, separate
from memory.py's factual memory. Storage itself is covered by real-SQLite
tests in tests/test_db.py; these cover slugify, formatting, and tool
dispatch with db.py mocked out.

    python -m unittest tests.test_knowledge -v
"""
import unittest
from unittest import mock

import knowledge


class SlugifyTest(unittest.TestCase):
    def test_lowercases_and_hyphenates(self):
        self.assertEqual(knowledge.slugify("Spin Up A Node Repo"), "spin-up-a-node-repo")

    def test_strips_punctuation(self):
        self.assertEqual(knowledge.slugify("Deploy to Railway!! (quick)"), "deploy-to-railway-quick")

    def test_same_title_produces_same_slug(self):
        self.assertEqual(knowledge.slugify("Deploy to Railway"), knowledge.slugify("Deploy to Railway"))

    def test_empty_title_falls_back(self):
        self.assertEqual(knowledge.slugify("   "), "entry")


class SaveTest(unittest.IsolatedAsyncioTestCase):
    async def test_requires_title_and_content(self):
        result = await knowledge.save(1, "", "some content")
        self.assertIn("required", result)
        result = await knowledge.save(1, "a title", "")
        self.assertIn("required", result)

    async def test_reports_new_vs_updated(self):
        with mock.patch.object(knowledge.db, "kb_get", mock.AsyncMock(return_value=None)), \
             mock.patch.object(knowledge.db, "kb_save", mock.AsyncMock()) as fake_save:
            result = await knowledge.save(1, "Deploy", "steps")
        self.assertIn("Saved new", result)
        fake_save.assert_awaited_once_with(1, "deploy", "Deploy", "steps")

        with mock.patch.object(knowledge.db, "kb_get", mock.AsyncMock(return_value={"slug": "deploy"})), \
             mock.patch.object(knowledge.db, "kb_save", mock.AsyncMock()):
            result = await knowledge.save(1, "Deploy", "corrected steps")
        self.assertIn("Updated existing", result)


class RunToolTest(unittest.IsolatedAsyncioTestCase):
    async def test_dispatches_to_the_right_function(self):
        with mock.patch.object(knowledge, "search", mock.AsyncMock(return_value="search result")):
            self.assertEqual(await knowledge.run_tool(1, "kb_search", {"query": "x"}), "search result")

        with mock.patch.object(knowledge, "list_entries", mock.AsyncMock(return_value="list result")):
            self.assertEqual(await knowledge.run_tool(1, "kb_list", {}), "list result")

        with mock.patch.object(knowledge, "save", mock.AsyncMock(return_value="save result")):
            self.assertEqual(
                await knowledge.run_tool(1, "kb_save", {"title": "t", "content": "c"}), "save result")

    async def test_unknown_tool_name(self):
        result = await knowledge.run_tool(1, "kb_nonsense", {})
        self.assertIn("Unknown", result)


class FormatEntriesTest(unittest.TestCase):
    def test_no_matches(self):
        self.assertIn("No matching", knowledge._format_entries([], with_content=True))

    def test_with_content_includes_body(self):
        text = knowledge._format_entries(
            [{"title": "Deploy", "slug": "deploy", "content": "step one"}], with_content=True)
        self.assertIn("Deploy", text)
        self.assertIn("step one", text)

    def test_without_content_omits_body(self):
        text = knowledge._format_entries(
            [{"title": "Deploy", "slug": "deploy", "content": "step one"}], with_content=False)
        self.assertIn("Deploy", text)
        self.assertNotIn("step one", text)


if __name__ == "__main__":
    unittest.main()
