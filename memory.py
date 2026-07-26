"""Live persistent memory for the AI, per guild — plus per-member profile
cards so a specific person's context doesn't get lost inside the general
guild-wide dump.

Every turn — text or voice, from any speaker — triggers a background
consolidation call that rewrites both durable memory (stable, guild-wide
facts, preferences, and decisions, each dated with a confidence level) and
working memory (current topic, active speakers, open questions, recent
exchanges) in one shot from the full recent turn buffer. There's no turn-
count or time-based batching: something said in text chat is folded into
memory right away, so it's already there — same as voice — the next time
anyone talks to the bot in either modality. This used to be throttled to
save spend on a paid model; now that background calls route through a free
model pool, there's no reason to batch, so every turn runs it.

Member profiles: consolidation tags every fact with the member it came from
or is about (a system instruction baked into the consolidation prompt) and
maintains one card per member — goals, active projects, constraints, vibe
notes, last conversation date. Retrieval checks whether the person currently
talking has a card; if they do, it's loaded first, ahead of the general
guild dump, so a specific member isn't glossed over in a sea of unrelated
facts. After every consolidation, a deterministic (non-LLM) check verifies
each active member's facts actually survived into the output; if a member's
content looks dropped — especially likely when their turns were dense — it's
flagged and their raw turns are retained to be re-fed, with emphasis, into
the next consolidation instead of being silently lost.

Every turn is tagged with where it happened — a text channel name or a
voice channel name — so the bot can tell "you asked me that in #general"
from "you asked me that in voice", and consolidation is instructed to keep
that location attached to a fact when it matters. Text turns are recorded
for every message posted anywhere in the server (not just messages that
address the bot directly), so something posted in one channel can be
recalled later from a completely different channel or from voice.

Everything lives in SQLite (db.memory) with atomic writes and the last 10
versions archived. Turns come from text chat and voice transcription alike;
the goal is to keep what changes what the bot would say next, not the whole
archaeological record.
"""
import asyncio
import json
import logging
import re
import time
from collections import defaultdict, deque

import db
import openrouter

log = logging.getLogger("memory")

TURN_BUFFER = 60         # raw turns kept per guild for consolidation to read
TURN_MAX_CHARS = 300     # per-turn cap fed to the updater
WORKING_MAX = 2500       # char caps requested from the model
DURABLE_MAX = 5000
PROFILE_FIELD_MAX = 400  # per-field cap on a profile card

# Preservation spot-check: a member's raw turns this round must overlap this
# much (by significant-word set) with what the model kept about them, once
# their raw content is substantial enough to be worth checking at all.
DROP_CHECK_MIN_CHARS = 150
DROP_PRESERVATION_MIN = 0.12
PENDING_MAX = 2000        # raw text carried forward for a retry, capped

_STOPWORDS = {
    "about", "after", "again", "their", "there", "these", "those", "which",
    "would", "could", "should", "because", "before", "still", "where",
    "while", "being", "doing", "going", "think", "thought", "really",
    "actually", "someone", "something", "anything", "everything", "people",
}

_turns: dict[int, deque] = defaultdict(lambda: deque(maxlen=TURN_BUFFER))
_consolidating: dict[int, bool] = defaultdict(bool)  # a consolidation is in flight
_pending: dict[int, bool] = defaultdict(bool)        # turns arrived while it was running

CONSOLIDATE_PROMPT = (
    "You maintain the memory of a Discord server bot: durable guild-wide "
    "memory, working memory, and per-member profile cards.\n\n"
    "SYSTEM INSTRUCTION: before writing anything, tag every fact you find "
    "with the member it came from or is about, using their display name "
    "exactly as it appears in the turns below. A fact about one specific "
    "member belongs on that member's profile card, not folded into general "
    "durable memory. Only genuinely guild-wide facts — not about one "
    "person — go in durable memory. Do not drop a member's facts just "
    "because their turns are dense or another member talked more this "
    "round: every member with substantive new information below must get "
    "a profile update.\n\n"
    "DURABLE MEMORY (guild-wide facts, dated, confidence-tagged) — today "
    "is {today}:\n{durable}\n\n"
    "WORKING MEMORY (live conversation context):\n{working}\n\n"
    "CURRENT MEMBER PROFILES (update these — merge in new information, "
    "keep existing fields the new turns don't mention):\n{profiles_block}\n\n"
    "RECENT TURNS — each is tagged with where it happened, e.g. \"[#general]\" "
    "for a text channel or \"[voice/General]\" for a voice channel — keep that "
    "location when it's relevant to a fact or open question, so the bot can "
    "later answer things like \"did you see what I posted in #general\":\n"
    "{turns}\n\n"
    "Roll working memory into durable memory: merge, dedupe, drop "
    "superseded entries (durable under {durable_max} chars). Trim working "
    "memory to only still-live context (under {working_max} chars). "
    "Profile card fields: goals, active_projects, constraints, "
    "vibe_notes — each a short string.\n"
    'Reply with ONLY a JSON object: {{"durable": "...", "working": "...", '
    '"profiles": {{"<member display name>": {{"goals": "...", '
    '"active_projects": "...", "constraints": "...", "vibe_notes": "..."'
    '}}}}}}\n'
    'Only include members in "profiles" who had genuinely new or updated '
    "information this round."
)


def record_turn(guild_id: int, speaker: str, text: str, source: str = "text",
                user_id: int | None = None, channel: str = "") -> None:
    """Buffer a conversation turn and trigger a live memory consolidation.

    user_id identifies the human who said this (for profile-card tagging at
    consolidation time). Leave it None for the bot's own turns — Max doesn't
    get a profile card built about himself. channel is the name of the text
    or voice channel the turn happened in, so memory (and the model) can
    tell where something was said, not just that it was said — the whole
    point of "did you see what I posted in #general"."""
    text = (text or "").strip()
    if not text:
        return
    _turns[guild_id].append({
        "speaker": speaker, "user_id": user_id, "text": text[:TURN_MAX_CHARS],
        "source": source, "channel": channel, "ts": time.time(),
    })
    _trigger_consolidation(guild_id)


def _trigger_consolidation(guild_id: int) -> None:
    """Run consolidation for every turn (it's live now, not batched) — but
    coalesce instead of piling up overlapping calls: if one is already in
    flight for this guild, just flag that fresher turns arrived, and the
    in-flight run loops once more for them right after it finishes."""
    if _consolidating[guild_id]:
        _pending[guild_id] = True
        return
    _consolidating[guild_id] = True
    if not _schedule(_consolidate_loop(guild_id)):
        _consolidating[guild_id] = False  # couldn't schedule; don't wedge future turns


async def _consolidate_loop(guild_id: int) -> None:
    try:
        while True:
            _pending[guild_id] = False
            await _consolidate(guild_id)
            if not _pending[guild_id]:
                return
    finally:
        _consolidating[guild_id] = False


def _schedule(coro) -> bool:
    async def runner():
        try:
            await coro
        except Exception:
            log.exception("Memory maintenance failed")
    try:
        asyncio.get_running_loop().create_task(runner())
        return True
    except RuntimeError:
        coro.close()  # no loop (tests); maintenance just skips
        return False


def _format_turns(turns: list[dict]) -> str:
    def location(t: dict) -> str:
        if not t.get("channel"):
            return t["source"]
        return f"#{t['channel']}" if t["source"] == "text" else f"voice/{t['channel']}"
    return "\n".join(f"[{location(t)}] {t['speaker']}: {t['text']}" for t in turns)


async def get_context(guild_id: int, user_id: int | None = None) -> str:
    """Memory block for injection into the system prompt ("" if empty).

    When user_id is given and that member has a profile card, it's loaded
    FIRST — ahead of the general guild-wide dump — so a specific person's
    context isn't glossed over in a sea of unrelated facts."""
    parts = []
    if user_id is not None:
        profile_block = await _format_profile(guild_id, user_id)
        if profile_block:
            parts.append(profile_block)
    durable, _ = await db.get_memory(guild_id, "durable")
    working, _ = await db.get_memory(guild_id, "working")
    if durable:
        parts.append(f"[DURABLE MEMORY — long-term facts you know]\n{durable}")
    if working:
        parts.append(f"[WORKING MEMORY — the current conversation context]\n{working}")
    return "\n\n".join(parts)


async def _format_profile(guild_id: int, user_id: int) -> str:
    card = await _load_profile(guild_id, user_id)
    if not card:
        return ""
    lines = [f"Name: {card.get('name', '?')}"]
    for label, key in (("Goals", "goals"), ("Active projects", "active_projects"),
                       ("Constraints", "constraints"), ("Vibe notes", "vibe_notes")):
        if card.get(key):
            lines.append(f"{label}: {card[key]}")
    if card.get("last_conversation"):
        lines.append(f"Last conversation: {card['last_conversation']}")
    return "[SPEAKER PROFILE — who you're talking to right now]\n" + "\n".join(lines)


async def _load_profile(guild_id: int, user_id: int) -> dict | None:
    raw, _ = await db.get_memory(guild_id, f"profile:{user_id}")
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


async def _model(guild_id: int):
    return await db.get_setting(guild_id, "ai_utility_model")


async def _consolidate(guild_id: int) -> None:
    durable, _ = await db.get_memory(guild_id, "durable")
    working, _ = await db.get_memory(guild_id, "working")
    turns = list(_turns[guild_id])
    if not (working or turns):
        return

    # Group this round's turns by member (bot's own turns carry no
    # user_id and are excluded — Max doesn't get profiled).
    by_member: dict[int, list[dict]] = defaultdict(list)
    names: dict[int, str] = {}
    for t in turns:
        if t["user_id"] is None:
            continue
        by_member[t["user_id"]].append(t)
        names[t["user_id"]] = t["speaker"]  # latest display name wins

    pending_by_member: dict[int, str] = {}
    profile_lines = []
    for uid, name in names.items():
        existing = await _load_profile(guild_id, uid)
        pending, _ = await db.get_memory(guild_id, f"pending:{uid}")
        if pending:
            pending_by_member[uid] = pending
        line = f"{name}: {json.dumps(existing) if existing else '(no card yet)'}"
        if pending:
            line += (f"\n  [NOTE: facts about {name} were dropped in a prior "
                    f"pass — make sure these are captured this time: {pending}]")
        profile_lines.append(line)
    profiles_block = "\n".join(profile_lines) or "(no members with new activity this round)"

    prompt = CONSOLIDATE_PROMPT.format(
        today=time.strftime("%Y-%m-%d"),
        durable=durable or "(empty)", working=working or "(empty)",
        profiles_block=profiles_block,
        turns=_format_turns(turns) or "(none)",
        durable_max=DURABLE_MAX, working_max=WORKING_MAX,
    )
    try:
        reply = await openrouter.chat(
            [{"role": "user", "content": prompt}],
            model=await _model(guild_id), temperature=0.2, max_tokens=2500,
            background=True,
        )
    except openrouter.OpenRouterError as exc:
        log.warning("Memory consolidation failed: %s", exc)
        return

    parsed = _parse_consolidation(reply)
    if parsed is None:
        log.warning("Consolidation reply unparseable; keeping files as-is")
        return
    new_durable, new_working, profile_updates = parsed

    await db.set_memory(guild_id, "durable", new_durable[:DURABLE_MAX + 1000])
    await db.set_memory(guild_id, "working", new_working[:WORKING_MAX + 500])

    updated_by_name = {str(k).strip().lower(): v for k, v in profile_updates.items()
                       if isinstance(v, dict)}

    for uid, member_turns in by_member.items():
        name = names[uid]
        raw_text = "\n".join(t["text"] for t in member_turns)
        if uid in pending_by_member:
            raw_text = pending_by_member[uid] + "\n" + raw_text
        new_fields = updated_by_name.get(name.strip().lower())

        substantial = len(raw_text) >= DROP_CHECK_MIN_CHARS
        ratio = _preservation_ratio(raw_text, json.dumps(new_fields) if new_fields else "")
        if substantial and ratio < DROP_PRESERVATION_MIN:
            log.warning(
                "consolidation may have dropped %s's facts (preservation "
                "%.0f%%, %d raw chars) — flagging and retaining raw turns "
                "for the next pass", name, ratio * 100, len(raw_text))
            await db.set_memory(guild_id, f"pending:{uid}", raw_text[-PENDING_MAX:])
        elif uid in pending_by_member:
            await db.set_memory(guild_id, f"pending:{uid}", "")  # captured now

        if new_fields:
            await _save_profile(guild_id, uid, name, new_fields)

    log.info("Memory consolidated for guild %s (%d member(s) active this round)",
             guild_id, len(by_member))


async def _save_profile(guild_id: int, user_id: int, name: str, fields: dict) -> None:
    """Merge new profile fields into the member's card — never blind-overwrite
    fields the model didn't mention this round."""
    existing = await _load_profile(guild_id, user_id) or {}
    existing["name"] = name
    existing["user_id"] = user_id
    existing["last_conversation"] = time.strftime("%Y-%m-%d")
    for key in ("goals", "active_projects", "constraints", "vibe_notes"):
        value = fields.get(key)
        if value:
            existing[key] = str(value)[:PROFILE_FIELD_MAX]
    await db.set_memory(guild_id, f"profile:{user_id}", json.dumps(existing))


_ACRONYM_RE = re.compile(r"\b[A-Z]{2,6}\b|\b[A-Za-z]+\d+\b|\b\d+[A-Za-z]+\b")


def _significant_tokens(text: str) -> set[str]:
    words = {w for w in re.findall(r"[a-z]{5,}", text.lower()) if w not in _STOPWORDS}
    # A pure length filter throws away short technical terms that carry most
    # of the meaning in a constraint/project fact (TLS, ARM, arm64, 256mb) —
    # catch acronyms and alphanumeric tokens from the original-case text too.
    words |= {w.lower() for w in _ACRONYM_RE.findall(text)}
    return words


def _preservation_ratio(raw_text: str, output_text: str) -> float:
    """Fraction of raw_text's significant vocabulary that survived into
    output_text — a cheap, deterministic stand-in for 'did the model
    actually keep this,' with no extra model call."""
    raw_tokens = _significant_tokens(raw_text)
    if not raw_tokens:
        return 1.0  # nothing substantive to lose
    out_tokens = _significant_tokens(output_text)
    return len(raw_tokens & out_tokens) / len(raw_tokens)


def _parse_consolidation(reply: str) -> tuple[str, str, dict] | None:
    """Extract {"durable", "working", "profiles"} from the model reply,
    tolerating code fences."""
    text = reply.strip()
    if text.startswith("```"):
        text = text.split("```", 2)[1]
        text = text.split("\n", 1)[1] if "\n" in text else text
        text = text.rsplit("```", 1)[0] if "```" in text else text
    try:
        start, end = text.index("{"), text.rindex("}") + 1
        data = json.loads(text[start:end])
    except (ValueError, json.JSONDecodeError):
        return None
    durable = str(data.get("durable", "")).strip()
    working = str(data.get("working", "")).strip()
    profiles = data.get("profiles")
    if not isinstance(profiles, dict):
        profiles = {}
    return durable, working, profiles
