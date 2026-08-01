"""Tests for db.py's manuscript and turn-durability storage, run against a
real (temp-file) SQLite database rather than mocks — these are the actual
queries the live bot runs, so they need real coverage, not just memory.py's
mocked-out call sites.

    python -m unittest tests.test_db -v
"""
import tempfile
import unittest

import config
import db


class DbTestCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        config.DATABASE_PATH = tempfile.mktemp(suffix=".db")
        await db.init_db()

    async def asyncTearDown(self):
        await db.close_db()


class KnowledgeBaseTest(DbTestCase):
    async def test_save_creates_and_get_returns_it(self):
        await db.kb_save(1, "spin-up-node-repo", "Spin up a Node repo",
                          "1. clone 2. npm install 3. npm run dev")
        entry = await db.kb_get(1, "spin-up-node-repo")
        self.assertEqual(entry["title"], "Spin up a Node repo")
        self.assertIn("npm install", entry["content"])

    async def test_get_missing_entry_is_none(self):
        self.assertIsNone(await db.kb_get(1, "nope"))

    async def test_save_same_slug_overwrites(self):
        await db.kb_save(1, "deploy", "Deploy", "old steps")
        await db.kb_save(1, "deploy", "Deploy", "corrected steps")
        entry = await db.kb_get(1, "deploy")
        self.assertEqual(entry["content"], "corrected steps")

    async def test_list_returns_titles_without_content(self):
        await db.kb_save(1, "a", "Entry A", "content a")
        await db.kb_save(1, "b", "Entry B", "content b")
        entries = await db.kb_list(1)
        self.assertEqual({e["title"] for e in entries}, {"Entry A", "Entry B"})
        self.assertNotIn("content", entries[0])

    async def test_search_matches_title_and_content(self):
        await db.kb_save(1, "node-setup", "Node repo setup", "run npm install first")
        await db.kb_save(1, "python-setup", "Python repo setup", "run pip install first")
        by_title = await db.kb_search(1, "Node")
        self.assertEqual([e["slug"] for e in by_title], ["node-setup"])
        by_content = await db.kb_search(1, "pip install")
        self.assertEqual([e["slug"] for e in by_content], ["python-setup"])

    async def test_entries_are_isolated_per_guild(self):
        await db.kb_save(1, "x", "X", "guild 1 content")
        await db.kb_save(2, "x", "X", "guild 2 content")
        self.assertEqual((await db.kb_get(1, "x"))["content"], "guild 1 content")
        self.assertEqual((await db.kb_get(2, "x"))["content"], "guild 2 content")

    async def test_delete_removes_entry_and_reports_whether_it_existed(self):
        await db.kb_save(1, "temp", "Temp", "content")
        self.assertTrue(await db.kb_delete(1, "temp"))
        self.assertIsNone(await db.kb_get(1, "temp"))
        self.assertFalse(await db.kb_delete(1, "temp"))


class ManuscriptTest(DbTestCase):
    async def test_append_creates_and_grows_the_manuscript(self):
        await db.append_manuscript(1, 42, "chapter one")
        self.assertEqual(await db.get_manuscript(1, 42), "chapter one")
        await db.append_manuscript(1, 42, "chapter two")
        self.assertEqual(await db.get_manuscript(1, 42), "chapter one\n\nchapter two")

    async def test_get_manuscript_empty_when_none_yet(self):
        self.assertEqual(await db.get_manuscript(1, 999), "")

    async def test_manuscripts_are_isolated_per_member(self):
        await db.append_manuscript(1, 1, "alice's story")
        await db.append_manuscript(1, 2, "bob's story")
        self.assertEqual(await db.get_manuscript(1, 1), "alice's story")
        self.assertEqual(await db.get_manuscript(1, 2), "bob's story")

    async def test_clear_manuscript_removes_it(self):
        await db.append_manuscript(1, 42, "some content")
        await db.clear_manuscript(1, 42)
        self.assertEqual(await db.get_manuscript(1, 42), "")



class TurnDurabilityStorageTest(DbTestCase):
    async def test_pending_turn_survives_until_marked_consolidated(self):
        await db.add_turn(1, 1, "travis", 42, "hello", "text", "general", 100.0)
        self.assertEqual(await db.get_pending_turn_guilds(), [1])
        pending = await db.get_pending_turns(1)
        self.assertEqual([t["text"] for t in pending], ["hello"])

        await db.mark_turns_consolidated(1, 1)
        self.assertEqual(await db.get_pending_turn_guilds(), [])
        self.assertEqual(await db.get_pending_turns(1), [])

    async def test_turn_is_never_deleted_after_consolidation_only_marked(self):
        await db.add_turn(1, 1, "travis", 42, "keep this forever", "text", "general", 100.0)
        await db.mark_turns_consolidated(1, 1)
        # No longer "pending", but still there for the permanent chat log.
        log = await db.get_chat_log(1, text_query="keep this")
        self.assertEqual([t["text"] for t in log], ["keep this forever"])

    async def test_chat_log_filters_by_speaker_and_keyword(self):
        await db.add_turn(1, 1, "alice", 1, "my birthday is march 3rd", "text", "general", 100.0)
        await db.add_turn(1, 2, "bob", 2, "my birthday is in june", "text", "general", 101.0)

        by_speaker = await db.get_chat_log(1, speaker_query="alice")
        self.assertEqual([t["text"] for t in by_speaker], ["my birthday is march 3rd"])

        by_keyword = await db.get_chat_log(1, text_query="june")
        self.assertEqual([t["text"] for t in by_keyword], ["my birthday is in june"])

    async def test_clear_memory_wipes_turns_but_not_manuscripts(self):
        await db.add_turn(1, 1, "travis", 42, "some chat", "text", "general", 100.0)
        await db.append_manuscript(1, 42, "the book, untouched")
        await db.clear_memory(1)
        self.assertEqual(await db.get_chat_log(1), [])
        self.assertEqual(await db.get_manuscript(1, 42), "the book, untouched")


if __name__ == "__main__":
    unittest.main()
