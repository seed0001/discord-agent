"""Live persistent memory for the AI, per guild — plus per-member profile
cards so a specific person's context doesn't get lost inside the general
guild-wide dump.

Every turn — text or voice, from any speaker — triggers a background
consolidation call that rewrites both durable memory (stable, guild-wide
facts, preferences, and decisions, each dated with a confidence level) and
working memory (current topic, active speakers, open questions, recent
exchanges) in one shot from whatever turns are new since the last
successful consolidation (a per-guild watermark, not the whole rolling
buffer — reprocessing everything already folded in on every single turn
would just make prompts and required output balloon for no benefit).
There's no turn-count or time-based batching: something said in text chat
is folded into memory right away, so it's already there — same as voice —
the next time anyone talks to the bot in either modality. This used to be
throttled to save spend on a paid model; now that background calls route
through a free model pool, there's no reason to batch, so every turn runs
it.

Member profiles: consolidation tags every fact with the member it came from
or is about (a system instruction baked into the consolidation prompt) and
maintains one card per member — goals, active projects, constraints, vibe
notes, a catch-all notes field for concrete details that don't fit those
categories, and last conversation date. The prompt pushes for specifics
(names, numbers, tools, exact preferences) over vague summaries, and fields
aren't capped tight enough to force compression of genuinely dense
information. Retrieval checks whether the person currently
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

Durability: the raw-turn buffer this module reasons from (_turns) is
in-process only, so a bare consolidation design would lose anything said
since the last successful run if the process died mid-consolidation — a
Railway redeploy killing the bot the moment someone hands it a wall of
detail, say. Every turn is also written to db.turns the instant it's
recorded, before consolidation ever runs; restore_pending_turns(), called
once at startup, replays whatever's still there (i.e. never made it through
a successful consolidation) back into the buffer and immediately re-triggers
consolidation for it, so a mid-flight kill loses at most the time it takes
one SQLite insert to land, not a whole conversation.

db.turns also never gets deleted once consolidated — it's kept as a
permanent chat/voice log, not just a durability scratch pad. recall() (the
recall_chat_log tool, available in every chat surface) searches it directly,
by member and/or keyword, so if a consolidation pass ever compresses,
misses, or under-details something, the actual words said are still there
to go back to — the AI-summarized durable memory and profile cards are a
fast-path index into this log, not the only copy of what was said.

Every turn from the bot owner, specifically, is additionally appended
verbatim to their manuscript (db.manuscripts) — no toggle, no command,
unconditional, all the time. This is for long-form stuff meant to be kept
word for word rather than boiled down into a profile field or a durable
fact: a life story, a book draft. It runs alongside, not instead of, the
normal durable/profile consolidation above. /manuscript (bot/cogs/ai.py,
owner-only) reads it back or clears it.
"""
import asyncio
import json
import logging
import re
import time
from collections import defaultdict, deque

import config
import db
import openrouter
from gudda_bridge import BinaryHDVector, HDVector, encode_turn, bundle_all

log = logging.getLogger("memory")

TURN_BUFFER = 60         # raw turns kept per guild for consolidation to read
TURN_MAX_CHARS = 300     # per-turn cap fed to the updater
WORKING_MAX = 2500       # char caps requested from the model
DURABLE_MAX = 5000
PROFILE_FIELD_MAX = 800  # per-field cap on a profile card

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

# ===================================================================
# HD Memory Accumulator Store
# ===================================================================
HD_DIM = 10000


class HDMemoryStore:
    """Per-guild hypervector accumulators for zero-latency similarity retrieval.

    Conjunctive accumulator: real-valued MAP sum of turn vectors (element-wise
    addition).  Binarized on query to yield the current majority-rule / "common
    ground" vector.

    Disjunctive accumulator: same approach but updated sparsely to capture
    topic breadth without saturating on high-frequency signals.

    Profile hypervectors: one per member, superposed from profile card fields
    via deterministic from_key + bundle_all (one-shot, not accumulated).
    """

    SAVE_EVERY = 25  # persist to SQLite every N ingested turns

    __slots__ = (
        "guild_id", "_conjunctive", "_disjunctive",
        "_profile_vectors", "_turn_count", "_save_counter",
    )

    def __init__(self, guild_id: int):
        self.guild_id = guild_id
        # Internal: MAP real-valued accumulators (never stored externally —
        # binarized on save and on query).
        self._conjunctive: HDVector | None = None
        self._disjunctive: HDVector | None = None
        self._profile_vectors: dict[int, BinaryHDVector] = {}
        self._turn_count = 0
        self._save_counter = 0

    # -- ingestion -----------------------------------------------------------

    def ingest_turn(self, vec: BinaryHDVector) -> None:
        """Update MAP accumulators with a single turn vector."""
        self._turn_count += 1
        # Convert BSC 0/1 → MAP ±1 for real-valued accumulation
        bits = vec.to_bits()
        map_vec = HDVector(HD_DIM, [1.0 if b else -1.0 for b in bits])

        # Conjunctive: always add (element-wise sum → majority on query)
        if self._conjunctive is None:
            self._conjunctive = map_vec
        else:
            self._conjunctive = self._conjunctive.bundle(map_vec)

        # Disjunctive: every 5th turn (sparse — avoids over-weighting
        # high-frequency chatter)
        if self._turn_count % 5 == 1:
            if self._disjunctive is None:
                self._disjunctive = map_vec
            else:
                self._disjunctive = self._disjunctive.bundle(map_vec)

        self._save_counter += 1

    # -- query helpers  (binarize MAP → BSC) ---------------------------------

    def _binarize(self, acc: HDVector | None) -> BinaryHDVector | None:
        if acc is None:
            return None
        # sign-threshold:  x > 0 → 1,  x ≤ 0 → 0
        bits = [1 if x > 0 else 0 for x in acc.data]
        return BinaryHDVector(HD_DIM, bits)

    def get_conjunctive(self) -> BinaryHDVector | None:
        return self._binarize(self._conjunctive)

    def get_disjunctive(self) -> BinaryHDVector | None:
        return self._binarize(self._disjunctive)

    # -- profile vectors -----------------------------------------------------

    def set_profile_vector(self, user_id: int, fields: dict) -> None:
        """Superpose profile card fields into a unified member hypervector."""
        vecs = []
        for key in ("goals", "active_projects", "constraints", "vibe_notes"):
            val = fields.get(key)
            if val:
                vecs.append(BinaryHDVector.from_key(f"{key}:{val}", HD_DIM))
        if vecs:
            self._profile_vectors[user_id] = bundle_all(*vecs, dim=HD_DIM)
        elif user_id in self._profile_vectors:
            del self._profile_vectors[user_id]

    def get_profile_vector(self, user_id: int) -> BinaryHDVector | None:
        return self._profile_vectors.get(user_id)

    # -- persistence ---------------------------------------------------------

    async def save(self) -> None:
        """Persist binarized accumulators to SQLite."""
        conj = self.get_conjunctive()
        if conj is not None:
            await db.save_hd_memory(self.guild_id, "conjunctive",
                                    conj.to_bits(), HD_DIM)
        disj = self.get_disjunctive()
        if disj is not None:
            await db.save_hd_memory(self.guild_id, "disjunctive",
                                    disj.to_bits(), HD_DIM)
        for uid, pv in self._profile_vectors.items():
            await db.save_hd_memory(self.guild_id, f"profile:{uid}",
                                    pv.to_bits(), HD_DIM)
        self._save_counter = 0

    async def load(self) -> None:
        """Restore binarized accumulators from SQLite.

        Because MAP sum is not stored (only its binarized snapshot), the
        restored accumulator has no historical weight — it's a "cold restart."
        New turns ingested after load rebuild the real-valued sum from here.
        """
        con = await db.get_hd_memory(self.guild_id, "conjunctive")
        if con:
            bits, _ = con
            # Rebuild MAP sum from binarized form: +1 for 1, -1 for 0,
            # scaled by 1 so sign-threshold returns the same bits.
            data = [1.0 if b else -1.0 for b in bits]
            self._conjunctive = HDVector(HD_DIM, data)
        dis = await db.get_hd_memory(self.guild_id, "disjunctive")
        if dis:
            bits, _ = dis
            data = [1.0 if b else -1.0 for b in bits]
            self._disjunctive = HDVector(HD_DIM, data)

    # -- zero-latency queries ------------------------------------------------

    def get_context(self) -> dict:
        """Return binarized accumulators for immediate use — zero I/O."""
        return {
            "conjunctive": self.get_conjunctive(),
            "disjunctive": self.get_disjunctive(),
            "profile_vectors": dict(self._profile_vectors),
        }


_stores: dict[int, HDMemoryStore] = {}
_turns: dict[int, deque] = defaultdict(lambda: deque(maxlen=TURN_BUFFER))
_consolidating: dict[int, bool] = defaultdict(bool)  # a consolidation is in flight
_pending: dict[int, bool] = defaultdict(bool)        # turns arrived while it was running
_next_seq: dict[int, int] = defaultdict(int)             # per-guild turn counter
_last_consolidated_seq: dict[int, int] = defaultdict(int)  # high-water mark already folded in

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
    "Capture SPECIFICS, not summaries: names, numbers, dates, tool/tech "
    "names, exact preferences, personal history, anything concrete. "
    "'they mentioned a project' is useless; 'building a Discord bot called "
    "Max on Railway, using OpenRouter' is what you're for. When a fact "
    "doesn't fit goals/active_projects/constraints/vibe_notes, it still "
    "belongs somewhere — put it in notes rather than leaving it out. "
    "Never compress a member's turns into a vaguer restatement just to "
    "save space; drop something only when it's truly superseded by "
    "newer information about the same thing.\n\n"
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
    "Profile card fields: goals, active_projects, constraints, vibe_notes, "
    "notes (catch-all for concrete facts about them that don't fit the "
    "other fields — the more specific the better) — each a string, and "
    "each can run long if there's genuinely that much detail to keep.\n"
    'Reply with ONLY a JSON object: {{"durable": "...", "working": "...", '
    '"profiles": {{"<member display name>": {{"goals": "...", '
    '"active_projects": "...", "constraints": "...", "vibe_notes": "...", '
    '"notes": "..."}}}}}}\n'
    'Only include members in "profiles" who had genuinely new or updated '
    "information this round."
)


def record_turn(guild_id: int, speaker: str, text: str, source: str = "text",
                user_id: int | None = None, channel: str = "") -> None:
    """Buffer a conversation turn and trigger a live memory consolidation.

    Also encodes the turn into a hypervector and updates the per-guild HD
    memory accumulators for zero-latency similarity queries.

    user_id identifies the human who said this (for profile-card tagging at
    consolidation time). Leave it None for the bot's own turns — Max doesn't
    get a profile card built about himself. channel is the name of the text
    or voice channel the turn happened in, so memory (and the model) can
    tell where something was said, not just that it was said — the whole
    point of "did you see what I posted in #general"."""
    text = (text or "").strip()
    if not text:
        return
    # Sequence numbers start at 1 so the "nothing consolidated yet"
    # watermark of 0 doesn't exclude the very first turn (0 > 0 is False).
    _next_seq[guild_id] += 1
    seq = _next_seq[guild_id]
    turn = {
        "speaker": speaker, "user_id": user_id, "text": text[:TURN_MAX_CHARS],
        "source": source, "channel": channel, "ts": time.time(), "seq": seq,
    }
    _turns[guild_id].append(turn)

    # ── HD ingestion ───────────────────────────────────────────────────
    if guild_id not in _stores:
        store = HDMemoryStore(guild_id)
        _stores[guild_id] = store
    else:
        store = _stores[guild_id]
    vec = encode_turn(speaker, text, turn["ts"], source, dim=HD_DIM) if text else None
    if vec is not None:
        store.ingest_turn(vec)
    if store._save_counter >= HDMemoryStore.SAVE_EVERY:
        _schedule(store.save())

    # Durability backstop: persist the raw turn before consolidation ever
    # runs. Consolidation reads the in-memory deque, not this table — but if
    # the process dies (redeploy, crash) before a consolidation covering this
    # turn finishes, the deque is gone too, and without this write whatever
    # was just said would be lost forever instead of replayed on restart.
    # (The full, untruncated text is what's persisted/appended here — the
    # TURN_MAX_CHARS cap above only applies to what consolidation reads.)
    _schedule(_persist_turn(guild_id, seq, speaker, user_id, text,
                            source, channel, turn["ts"]))
    _trigger_consolidation(guild_id)


def _is_owner(user_id: int) -> bool:
    return bool(config.OWNER_ID) and user_id == config.OWNER_ID


async def _persist_turn(guild_id: int, seq: int, speaker: str, user_id: int | None,
                        text: str, source: str, channel: str, ts: float) -> None:
    await db.add_turn(guild_id, seq, speaker, user_id, text, source, channel, ts)
    # Manuscript: verbatim, unsummarized capture of everything the bot owner
    # says — no toggle, no command, unconditional, all the time. Not a
    # per-member feature and not opt-in; this is the owner's own long-form
    # record (life story, book draft) that must never depend on remembering
    # to turn something on first.
    if user_id is not None and _is_owner(user_id):
        await db.append_manuscript(guild_id, user_id, text)


async def restore_pending_turns() -> None:
    """Reload turns that were persisted but never made it through a
    successful consolidation before the last shutdown — e.g. a burst of
    detail given right as a redeploy killed the process mid-consolidation —
    so nothing said gets silently dropped. Call once at startup, after
    db.init_db(); each recovered guild's backlog is folded in immediately."""
    for guild_id in await db.get_pending_turn_guilds():
        rows = await db.get_pending_turns(guild_id)
        if not rows:
            continue
        for row in rows:
            _turns[guild_id].append(row)
        _next_seq[guild_id] = max(_next_seq[guild_id], rows[-1]["seq"])
        log.info("Recovered %d unconsolidated turn(s) for guild %s after restart",
                 len(rows), guild_id)
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


def _format_log_turns(turns: list[dict]) -> str:
    def location(t: dict) -> str:
        if not t.get("channel"):
            return t["source"]
        return f"#{t['channel']}" if t["source"] == "text" else f"voice/{t['channel']}"
    lines = []
    for t in turns:
        date = time.strftime("%Y-%m-%d %H:%M", time.localtime(t["ts"])) if t.get("ts") else "?"
        lines.append(f"[{date} {location(t)}] {t['speaker']}: {t['text']}")
    return "\n".join(lines)


RECALL_TOOL_SCHEMA = {
    "type": "function",
    "function": {
        "name": "recall_chat_log",
        "description": (
            "Search the permanent raw chat/voice log for this server — every "
            "turn ever recorded, not just what made it into durable memory "
            "or a profile card summary. Use this when someone asks what they "
            "told you before, references something you don't have "
            "summarized, or you want to double-check exactly what was said "
            "and when, instead of relying on a compressed summary."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "member": {"type": "string",
                          "description": "Filter to one member's display name (optional)"},
                "query": {"type": "string",
                         "description": "Keyword/phrase to search for in the text (optional)"},
                "limit": {"type": "integer",
                         "description": "Max turns to return, most recent first (default 40, max 100)"},
            },
            "required": [],
        },
    },
}


async def recall(guild_id: int, member: str | None = None, query: str | None = None,
                 limit: int = 40) -> str:
    """Search the permanent raw chat log directly — the actual words said,
    not the AI-summarized durable memory or profile cards — so a bad
    consolidation pass or an under-detailed profile never means the
    information is genuinely gone."""
    limit = max(1, min(int(limit or 40), 100))
    rows = await db.get_chat_log(guild_id, speaker_query=member or None,
                                 text_query=query or None, limit=limit)
    if not rows:
        return "No matching chat history found."
    return _format_log_turns(list(reversed(rows)))


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


def get_hd_context(guild_id: int, user_id: int | None = None) -> dict:
    """Zero-latency retrieval of HD memory accumulators.

    Returns dict with keys 'conjunctive', 'disjunctive', and (if user_id given)
    'profile' — each a BinaryHDVector or None. All vectors live in-memory after
    the most recent ingestion; no I/O is performed.
    """
    store = _stores.get(guild_id)
    if store is None:
        return {"conjunctive": None, "disjunctive": None, "profile": None}
    ctx = store.get_context()
    profile = store.get_profile_vector(user_id) if user_id is not None else None
    ctx["profile"] = profile
    return ctx


async def _format_profile(guild_id: int, user_id: int) -> str:
    card = await _load_profile(guild_id, user_id)
    if not card:
        return ""
    lines = [f"Name: {card.get('name', '?')}"]
    for label, key in (("Goals", "goals"), ("Active projects", "active_projects"),
                       ("Constraints", "constraints"), ("Vibe notes", "vibe_notes"),
                       ("Notes", "notes")):
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
    # Only what's new since the last successful consolidation — not the
    # whole rolling buffer. Running every turn already keeps memory live;
    # reprocessing up to 60 already-folded-in turns on top of that every
    # single time was pure waste (bigger prompts, bigger required output,
    # more truncation risk) for no benefit, since durable/working already
    # carry everything earlier turns contributed.
    watermark = _last_consolidated_seq[guild_id]
    new_turns = [t for t in _turns[guild_id] if t["seq"] > watermark]
    if not new_turns:
        return
    durable, _ = await db.get_memory(guild_id, "durable")
    working, _ = await db.get_memory(guild_id, "working")

    # Group this round's turns by member (bot's own turns carry no
    # user_id and are excluded — Max doesn't get profiled).
    by_member: dict[int, list[dict]] = defaultdict(list)
    names: dict[int, str] = {}
    for t in new_turns:
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
        turns=_format_turns(new_turns) or "(none)",
        durable_max=DURABLE_MAX, working_max=WORKING_MAX,
    )
    try:
        # Enough headroom to actually reproduce durable_max + working_max
        # chars plus profile JSON without getting cut off mid-object —
        # 2500 was routinely too tight and produced truncated, unparseable
        # JSON, silently dropping updates.
        reply = await openrouter.chat(
            [{"role": "user", "content": prompt}],
            model=await _model(guild_id), temperature=0.2, max_tokens=4096,
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
    _last_consolidated_seq[guild_id] = new_turns[-1]["seq"]
    # These turns are now safely folded into durable/working/profile
    # storage — mark them consolidated so they're not replayed at the next
    # startup. They stay in the table (never deleted) as the permanent,
    # searchable chat log recall_chat_log reads from below.
    _schedule(db.mark_turns_consolidated(guild_id, new_turns[-1]["seq"]))

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
    fields the model didn't mention this round.

    Also superposes the updated fields into a unified member hypervector."""
    existing = await _load_profile(guild_id, user_id) or {}
    existing["name"] = name
    existing["user_id"] = user_id
    existing["last_conversation"] = time.strftime("%Y-%m-%d")
    for key in ("goals", "active_projects", "constraints", "vibe_notes", "notes"):
        value = fields.get(key)
        if value:
            existing[key] = str(value)[:PROFILE_FIELD_MAX]
    await db.set_memory(guild_id, f"profile:{user_id}", json.dumps(existing))

    # Superpose into HD profile vector for zero-latency similarity queries
    store = _stores.get(guild_id)
    if store is not None:
        store.set_profile_vector(user_id, existing)


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
