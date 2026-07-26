"""Tests for memory.py's live (per-turn) consolidation trigger — every turn
schedules a consolidation, but overlapping calls coalesce instead of piling
up so a burst of rapid turns doesn't spawn a redundant run per message.

    python -m unittest tests.test_memory -v
"""
import asyncio
import unittest
from unittest import mock

import memory
import openrouter


class LiveConsolidationTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        memory._turns.clear()
        memory._consolidating.clear()
        memory._pending.clear()

    async def test_every_turn_triggers_consolidation(self):
        calls = []

        async def fake_consolidate(guild_id):
            calls.append(guild_id)

        with mock.patch.object(memory, "_consolidate", fake_consolidate):
            memory.record_turn(1, "alice", "hello")
            await asyncio.sleep(0)
            self.assertEqual(calls, [1])

    async def test_empty_text_does_not_schedule_anything(self):
        async def fake_consolidate(guild_id):
            self.fail("should not be called for an empty turn")

        with mock.patch.object(memory, "_consolidate", fake_consolidate):
            memory.record_turn(1, "alice", "   ")
            await asyncio.sleep(0)

    async def test_rapid_turns_coalesce_into_one_extra_run(self):
        gate = asyncio.Event()
        calls = []

        async def fake_consolidate(guild_id):
            calls.append(guild_id)
            await gate.wait()

        with mock.patch.object(memory, "_consolidate", fake_consolidate):
            memory.record_turn(1, "alice", "one")
            await asyncio.sleep(0)  # first run starts and blocks on the gate
            self.assertEqual(len(calls), 1)
            self.assertTrue(memory._consolidating[1])

            # more turns arrive while the first run is still in flight
            memory.record_turn(1, "bob", "two")
            memory.record_turn(1, "carol", "three")
            await asyncio.sleep(0)
            self.assertEqual(len(calls), 1, "no new run should start mid-flight")

            gate.set()  # let the first run finish
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            self.assertEqual(len(calls), 2, "exactly one coalesced follow-up run")
            self.assertFalse(memory._consolidating[1])

    async def test_guilds_are_independent(self):
        calls = []

        async def fake_consolidate(guild_id):
            calls.append(guild_id)

        with mock.patch.object(memory, "_consolidate", fake_consolidate):
            memory.record_turn(1, "alice", "hi in guild 1")
            memory.record_turn(2, "bob", "hi in guild 2")
            await asyncio.sleep(0)
            self.assertCountEqual(calls, [1, 2])


class ChannelTaggingTest(unittest.TestCase):
    def test_text_turn_formats_with_channel_name(self):
        line = memory._format_turns([
            {"speaker": "alice", "text": "posted the invoice", "source": "text", "channel": "general"},
        ])
        self.assertEqual(line, "[#general] alice: posted the invoice")

    def test_voice_turn_formats_with_channel_name(self):
        line = memory._format_turns([
            {"speaker": "bob", "text": "asked about it", "source": "voice", "channel": "General VC"},
        ])
        self.assertEqual(line, "[voice/General VC] bob: asked about it")

    def test_missing_channel_falls_back_to_source_only(self):
        line = memory._format_turns([
            {"speaker": "carol", "text": "hi", "source": "text", "channel": ""},
        ])
        self.assertEqual(line, "[text] carol: hi")

    def test_record_turn_stores_channel_on_the_buffered_turn(self):
        memory._turns.clear()
        memory.record_turn(1, "alice", "posted the invoice", "text", channel="general")
        turn = memory._turns[1][-1]
        self.assertEqual(turn["channel"], "general")
        self.assertEqual(turn["source"], "text")


def _add_turn(guild_id, speaker, text, source="text", channel="", user_id=None):
    """Append a turn directly, bypassing record_turn's own trigger — these
    tests call _consolidate() themselves for deterministic control, and
    don't want a second, unpatched real background consolidation firing
    alongside it."""
    memory._next_seq[guild_id] += 1
    memory._turns[guild_id].append({
        "speaker": speaker, "user_id": user_id, "text": text,
        "source": source, "channel": channel, "ts": 0,
        "seq": memory._next_seq[guild_id],
    })


class ConsolidateDeltaTest(unittest.IsolatedAsyncioTestCase):
    """_consolidate() must only send turns new since the last successful
    run (a per-guild watermark), not the whole rolling buffer every time —
    reprocessing everything already folded in bloated prompts/output and
    caused real truncated-JSON failures in production."""

    async def asyncSetUp(self):
        memory._turns.clear()
        memory._consolidating.clear()
        memory._pending.clear()
        memory._next_seq.clear()
        memory._last_consolidated_seq.clear()
        self.store = {}

        async def fake_get_memory(guild_id, kind):
            return self.store.get((guild_id, kind), ""), 0

        async def fake_set_memory(guild_id, kind, content):
            self.store[(guild_id, kind)] = content
            return 1

        async def fake_get_setting(guild_id, key):
            return None

        for target, fn in (("get_memory", fake_get_memory), ("set_memory", fake_set_memory),
                           ("get_setting", fake_get_setting)):
            patcher = mock.patch.object(memory.db, target, fn)
            patcher.start()
            self.addCleanup(patcher.stop)

    async def test_only_new_turns_are_sent_to_the_model(self):
        prompts = []

        async def fake_chat(messages, **kwargs):
            prompts.append(messages[0]["content"])
            return '{"durable": "d", "working": "w", "profiles": {}}'

        with mock.patch.object(memory.openrouter, "chat", fake_chat):
            _add_turn(1, "alice", "first message", channel="general")
            await memory._consolidate(1)
            self.assertIn("first message", prompts[0])

            _add_turn(1, "alice", "second message", channel="general")
            await memory._consolidate(1)
            self.assertNotIn("first message", prompts[1])
            self.assertIn("second message", prompts[1])

    async def test_watermark_does_not_advance_on_unparseable_reply(self):
        prompts = []

        async def fake_chat(messages, **kwargs):
            prompts.append(messages[0]["content"])
            return "not valid json at all"

        with mock.patch.object(memory.openrouter, "chat", fake_chat):
            _add_turn(1, "alice", "hello", channel="general")
            await memory._consolidate(1)
            self.assertEqual(memory._last_consolidated_seq[1], 0)

            await memory._consolidate(1)  # unconsolidated turn is retried
            self.assertIn("hello", prompts[1])

    async def test_watermark_does_not_advance_on_api_error(self):
        async def failing_chat(messages, **kwargs):
            raise openrouter.OpenRouterError("boom")

        with mock.patch.object(memory.openrouter, "chat", failing_chat):
            _add_turn(1, "alice", "hello", channel="general")
            await memory._consolidate(1)
            self.assertEqual(memory._last_consolidated_seq[1], 0)

    async def test_consolidation_call_has_generous_max_tokens(self):
        captured = {}

        async def fake_chat(messages, **kwargs):
            captured.update(kwargs)
            return '{"durable": "", "working": "", "profiles": {}}'

        with mock.patch.object(memory.openrouter, "chat", fake_chat):
            _add_turn(1, "alice", "hi", channel="general")
            await memory._consolidate(1)
        # 2500 was demonstrably too tight in production (truncated JSON,
        # "unparseable" every time output hit the cap) — guard against a
        # regression back to a too-small budget.
        self.assertGreaterEqual(captured.get("max_tokens", 0), 4096)

    async def test_no_new_turns_skips_the_model_call_entirely(self):
        called = False

        async def fake_chat(messages, **kwargs):
            nonlocal called
            called = True
            return '{"durable": "", "working": "", "profiles": {}}'

        with mock.patch.object(memory.openrouter, "chat", fake_chat):
            await memory._consolidate(1)  # nothing ever recorded for guild 1
        self.assertFalse(called)


class NoEventLoopTest(unittest.TestCase):
    """record_turn() may run outside an event loop (e.g. at import/shutdown);
    scheduling failure must not permanently wedge future consolidation."""

    def test_record_turn_outside_loop_does_not_wedge(self):
        memory._turns.clear()
        memory._consolidating.clear()
        memory._pending.clear()
        memory.record_turn(99, "alice", "hi")
        self.assertFalse(memory._consolidating[99])


if __name__ == "__main__":
    unittest.main()
