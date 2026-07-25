"""Two-tier persistent memory for the AI, per guild — plus per-member
profile cards so a specific person's context doesn't get lost inside the
general guild-wide dump.

Working memory: current topic, active speakers, decisions in play, open
questions, and the last 10-15 meaningful turns. Refreshed by the model every
WORKING_EVERY turns from the recent turn buffer.

Durable memory: stable, guild-wide facts, preferences, project details, and
resolved decisions — each entry dated with a confidence level. Working
memory rolls into it every CONSOLIDATE_EVERY turns (deduped, superseded
entries dropped), after which the working file is trimmed to just the live
context.

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
from gudda_bridge import BinaryHDVector, HDVector, encode_turn, bundle_all

log = logging.getLogger("memory")

WORKING_EVERY = 12       # turns between working-memory refreshes
CONSOLIDATE_EVERY = 25   # turns between working -> durable rollups
MIN_UPDATE_GAP_S = 120   # never refresh working memory more often than this
TURN_BUFFER = 60         # raw turns kept per guild for the updater to read
TURNS_FED = 30           # most recent turns actually sent to the model
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
_counts: dict[int, int] = defaultdict(int)
_since_rollup: dict[int, int] = defaultdict(int)
_last_update: dict[int, float] = defaultdict(float)
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
    "RECENT TURNS:\n{turns}\n\n"
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
                user_id: int | None = None) -> None:
    """Buffer a conversation turn and schedule memory maintenance.

    Also encodes the turn into a hypervector and updates the per-guild HD
    memory accumulators for zero-latency similarity queries.

    user_id identifies the human who said this (for profile-card tagging at
    consolidation time). Leave it None for the bot's own turns — Max doesn't
    get a profile card built about himself."""
    text = (text or "").strip()
    if not text:
        return
    _turns[guild_id].append({
        "speaker": speaker, "user_id": user_id, "text": text[:TURN_MAX_CHARS],
        "source": source, "ts": time.time(),
    })
    _counts[guild_id] += 1
    _since_rollup[guild_id] += 1

    # ── HD ingestion ───────────────────────────────────────────────────
    if guild_id not in _stores:
        store = HDMemoryStore(guild_id)
        _stores[guild_id] = store
    else:
        store = _stores[guild_id]
    vec = encode_turn(speaker, text, time.time(), source, dim=HD_DIM) if text else None
    if vec is not None:
        store.ingest_turn(vec)
    if store._save_counter >= HDMemoryStore.SAVE_EVERY:
        _schedule(store.save())

    if _since_rollup[guild_id] >= CONSOLIDATE_EVERY:
        _since_rollup[guild_id] = 0
        _schedule(_consolidate(guild_id))
    elif _counts[guild_id] % WORKING_EVERY == 0:
        # time gate on top of the turn counter: rapid voice chat shouldn't
        # trigger a model call every few seconds
        if time.time() - _last_update[guild_id] >= MIN_UPDATE_GAP_S:
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


def _format_turns(turns: list[dict]) -> str:
    return "\n".join(f"[{t['source']}] {t['speaker']}: {t['text']}" for t in turns)


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


async def _update_working(guild_id: int) -> None:
    async with _locks[guild_id]:
        _last_update[guild_id] = time.time()
        turns = _format_turns(list(_turns[guild_id])[-TURNS_FED:])
        if not turns:
            return
        working, _ = await db.get_memory(guild_id, "working")
        prompt = WORKING_PROMPT.format(
            working=working or "(empty)", turns=turns, max_chars=WORKING_MAX)
        try:
            updated = await openrouter.chat(
                [{"role": "user", "content": prompt}],
                model=await _model(guild_id), temperature=0.2, max_tokens=1200,
                background=True,
            )
        except openrouter.OpenRouterError as exc:
            log.warning("Working-memory update failed: %s", exc)
            return
        updated = updated.strip()
        # Free-pool models occasionally return junk (e.g. a bare safety
        # verdict) — never let that overwrite real memory
        if len(updated) < 40 or "\n" not in updated and len(updated) < 80:
            log.warning("Working-memory update rejected as junk: %r", updated[:80])
            return
        await db.set_memory(guild_id, "working", updated[:WORKING_MAX + 500])
        log.info("Working memory updated for guild %s", guild_id)


async def _consolidate(guild_id: int) -> None:
    async with _locks[guild_id]:
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
    fields the model didn't mention this round.

    Also superposes the updated fields into a unified member hypervector."""
    existing = await _load_profile(guild_id, user_id) or {}
    existing["name"] = name
    existing["user_id"] = user_id
    existing["last_conversation"] = time.strftime("%Y-%m-%d")
    for key in ("goals", "active_projects", "constraints", "vibe_notes"):
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
