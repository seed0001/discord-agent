"""Tests for memory.py's live (per-turn) consolidation trigger — every turn
schedules a consolidation, but overlapping calls coalesce instead of piling
up so a burst of rapid turns doesn't spawn a redundant run per message.

    python -m unittest tests.test_memory -v
"""
import asyncio
import unittest
from unittest import mock

import memory


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
