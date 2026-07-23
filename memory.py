"""Two-tier persistent memory for the AI, per guild.

Working memory: current topic, active speakers, decisions in play, open
questions, and the last 10-15 meaningful turns. Refreshed by the model every
WORKING_EVERY turns from the recent turn buffer.

Durable memory: stable facts, preferences, project details, and resolved
decisions — each entry dated with a confidence level. Working memory rolls
into it every CONSOLIDATE_EVERY turns (deduped, superseded entries dropped),
after which the working file is trimmed to just the live context.

Both files live in SQLite (db.memory) with atomic writes and the last 10
versions archived. Turns come from text chat and voice transcription alike;
the goal is to keep what changes what the bot would say next, not the whole
archaeological record.
"""
import asyncio
import json
import logging
import time
from collections import defaultdict, deque

import db
import openrouter

log = logging.getLogger("memory")

WORKING_EVERY = 5        # turns between working-memory refreshes
CONSOLIDATE_EVERY = 45   # turns between working -> durable rollups
TURN_BUFFER = 60         # raw turns kept per guild for the updater to read
TURN_MAX_CHARS = 400     # per-turn cap fed to the updater
WORKING_MAX = 2500       # char caps requested from the model
DURABLE_MAX = 5000

_turns: dict[int, deque] = defaultdict(lambda: deque(maxlen=TURN_BUFFER))
_counts: dict[int, int] = defaultdict(int)
_since_rollup: dict[int, int] = defaultdict(int)
_locks: dict[int, asyncio.Lock] = defaultdict(asyncio.Lock)

WORKING_PROMPT = (
    "You maintain the WORKING MEMORY file of a Discord server bot. It holds: "
    "current topic, active speakers, decisions in play, open questions, and "
    "the last 10-15 meaningful turns (paraphrased, attributed). Skip "
    "pleasantries, filler, and transcription noise — preserve what would "
    "change what the bot says next.\n\n"
    "CURRENT WORKING MEMORY:\n{working}\n\n"
    "RECENT TURNS (text and voice):\n{turns}\n\n"
    "Rewrite the working memory file incorporating the recent turns. Keep it "
    "under {max_chars} characters. Output ONLY the file content, no preamble."
)

CONSOLIDATE_PROMPT = (
    "You maintain the two memory files of a Discord server bot.\n"
    "DURABLE MEMORY holds stable facts, member preferences, project details, "
    "and resolved decisions — one per line, each ending with "
    "[YYYY-MM-DD, confidence: high|medium|low]. Today is {today}.\n"
    "WORKING MEMORY holds the live conversation context.\n\n"
    "CURRENT DURABLE MEMORY:\n{durable}\n\n"
    "CURRENT WORKING MEMORY:\n{working}\n\n"
    "RECENT TURNS:\n{turns}\n\n"
    "Roll the working memory into the durable memory: merge new stable "
    "facts/preferences/decisions, dedupe, drop superseded entries (durable "
    "under {durable_max} chars). Then trim the working memory to only the "
    "still-live context: current topic, open questions, unresolved threads "
    "(under {working_max} chars).\n"
    'Reply with ONLY a JSON object: {{"durable": "...", "working": "..."}}'
)


def record_turn(guild_id: int, speaker: str, text: str, source: str = "text") -> None:
    """Buffer a conversation turn and schedule memory maintenance."""
    text = (text or "").strip()
    if not text:
        return
    _turns[guild_id].append(f"[{source}] {speaker}: {text[:TURN_MAX_CHARS]}")
    _counts[guild_id] += 1
    _since_rollup[guild_id] += 1
    if _since_rollup[guild_id] >= CONSOLIDATE_EVERY:
        _since_rollup[guild_id] = 0
        _schedule(_consolidate(guild_id))
    elif _counts[guild_id] % WORKING_EVERY == 0:
        _schedule(_update_working(guild_id))


def _schedule(coro) -> None:
    async def runner():
        try:
            await coro
        except Exception:
            log.exception("Memory maintenance failed")
    try:
        asyncio.get_running_loop().create_task(runner())
    except RuntimeError:
        pass  # no loop (tests); maintenance just skips


async def get_context(guild_id: int) -> str:
    """Memory block for injection into the system prompt ("" if empty)."""
    durable, _ = await db.get_memory(guild_id, "durable")
    working, _ = await db.get_memory(guild_id, "working")
    parts = []
    if durable:
        parts.append(f"[DURABLE MEMORY — long-term facts you know]\n{durable}")
    if working:
        parts.append(f"[WORKING MEMORY — the current conversation context]\n{working}")
    return "\n\n".join(parts)


async def _model(guild_id: int):
    return await db.get_setting(guild_id, "ai_model")


async def _update_working(guild_id: int) -> None:
    async with _locks[guild_id]:
        turns = "\n".join(_turns[guild_id])
        if not turns:
            return
        working, _ = await db.get_memory(guild_id, "working")
        prompt = WORKING_PROMPT.format(
            working=working or "(empty)", turns=turns, max_chars=WORKING_MAX)
        try:
            updated = await openrouter.chat(
                [{"role": "user", "content": prompt}],
                model=await _model(guild_id), temperature=0.2, max_tokens=1200,
            )
        except openrouter.OpenRouterError as exc:
            log.warning("Working-memory update failed: %s", exc)
            return
        if updated.strip():
            await db.set_memory(guild_id, "working", updated.strip()[:WORKING_MAX + 500])
            log.info("Working memory updated for guild %s", guild_id)


async def _consolidate(guild_id: int) -> None:
    async with _locks[guild_id]:
        durable, _ = await db.get_memory(guild_id, "durable")
        working, _ = await db.get_memory(guild_id, "working")
        turns = "\n".join(_turns[guild_id])
        if not (working or turns):
            return
        prompt = CONSOLIDATE_PROMPT.format(
            today=time.strftime("%Y-%m-%d"),
            durable=durable or "(empty)", working=working or "(empty)",
            turns=turns or "(none)",
            durable_max=DURABLE_MAX, working_max=WORKING_MAX,
        )
        try:
            reply = await openrouter.chat(
                [{"role": "user", "content": prompt}],
                model=await _model(guild_id), temperature=0.2, max_tokens=2500,
            )
        except openrouter.OpenRouterError as exc:
            log.warning("Memory consolidation failed: %s", exc)
            return
        new_durable, new_working = _parse_consolidation(reply)
        if new_durable is None:
            log.warning("Consolidation reply unparseable; keeping files as-is")
            return
        await db.set_memory(guild_id, "durable", new_durable[:DURABLE_MAX + 1000])
        await db.set_memory(guild_id, "working", new_working[:WORKING_MAX + 500])
        log.info("Memory consolidated for guild %s", guild_id)


def _parse_consolidation(reply: str) -> tuple[str | None, str]:
    """Extract {"durable", "working"} from the model reply, tolerating fences."""
    text = reply.strip()
    if text.startswith("```"):
        text = text.split("```", 2)[1]
        text = text.split("\n", 1)[1] if "\n" in text else text
        text = text.rsplit("```", 1)[0] if "```" in text else text
    try:
        start, end = text.index("{"), text.rindex("}") + 1
        data = json.loads(text[start:end])
        return str(data.get("durable", "")).strip(), str(data.get("working", "")).strip()
    except (ValueError, json.JSONDecodeError):
        return None, ""
