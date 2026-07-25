"""Proactive speech — wires the pressure engine (pressure/) into Max.

Every guild message (and voice transcript, fed by the Voice cog) is
observed and classified into pressure signals by a cheap LLM call. A
background tick decays/flows pressure. When a (bucket, topic) crosses its
threshold and the deterministic speaking gate would allow it, Max drafts a
contribution in his own voice; the gate rules on the final draft, and only
then does he speak unprompted. Every limit — thresholds, cooldowns,
repetition, budgets, energy — is enforced by the engine, not the model.
"""
import asyncio
import json
import logging
import os
import time
from collections import defaultdict, deque

import discord
from discord import app_commands
from discord.ext import commands

import config
import db
import openrouter
import tts
from bot.cogs import voice as voice_mod
from bot.utils import owner_only
from gudda_bridge import GuddaBridge, BinaryHDVector, encode_text, sdm_snr_threshold
from pressure import PressureEngine, Proposal, Signal, SqliteStore

log = logging.getLogger("proactive")

TICK_EVERY = 30                 # seconds between engine ticks
CLASSIFY_MIN_INTERVAL = 20.0    # per-channel classification rate cap — messages
                                # in between are batched into the next call
CLASSIFY_MIN_CHARS = 12         # skip trivial messages
CONTEXT_LINES = 12              # recent lines given to classifier/drafter
VOICE_CONFIDENCE_SCALE = 0.85   # transcripts are noisier than typed text
HD_DIM = 10000                  # HD vector dimensionality

# Prototype signal vectors  (deterministic from_key)
HD_SIGNAL_PROTOTYPES: dict[str, BinaryHDVector] | None = None
_HD_SIM_THRESHOLD: float | None = None


def _init_hd_prototypes():
    """Build prototype vectors once."""
    global HD_SIGNAL_PROTOTYPES, _HD_SIM_THRESHOLD
    if HD_SIGNAL_PROTOTYPES is not None:
        return
    HD_SIGNAL_PROTOTYPES = {
        "incorrect_claim":  BinaryHDVector.from_key("signal:incorrect_claim", HD_DIM),
        "blocker":          BinaryHDVector.from_key("signal:blocker", HD_DIM),
        "safety_concern":   BinaryHDVector.from_key("signal:safety_concern", HD_DIM),
        "promised_followup": BinaryHDVector.from_key("signal:promised_followup", HD_DIM),
    }
    d_snr = sdm_snr_threshold(HD_DIM)          # Hamming distance
    _HD_SIM_THRESHOLD = 1.0 - d_snr / HD_DIM   # → XNOR similarity ∈ [0,1]


def _hd_preclassify(text: str) -> dict[str, float]:
    """Compute XNOR-popcount similarity of ``text`` against each prototype.

    Returns dict mapping signal source → similarity score.
    Similarity below SDM SNR threshold means the text is noise w.r.t. that
    signal — indistinguishable from random.
    """
    _init_hd_prototypes()
    if not text.strip():
        return {}
    fp = encode_text(text, HD_DIM)
    scores: dict[str, float] = {}
    for source, proto in HD_SIGNAL_PROTOTYPES.items():
        scores[source] = fp.xnor_popcount_similarity(proto)
    return scores


def _hd_any_signal(scores: dict[str, float]) -> bool:
    """True if at least one prototype scores above the SDM SNR threshold."""
    th = _HD_SIM_THRESHOLD
    return any(s >= th for s in scores.values())

CLASSIFY_PROMPT = (
    "You monitor a Discord channel for an assistant bot that may speak up "
    "unprompted when it truly has something to offer. Given the recent "
    "messages and the newest one, emit conversational pressure signals.\n"
    "Allowed sources: {sources}\n"
    'Reply ONLY with JSON: {{"topic": "short-kebab-slug", "signals": '
    '[{{"source": "...", "confidence": 0.0-1.0, "evidence": "one short line"}}]}}\n'
    "topic = what the conversation is about right now (always set it). "
    "For ordinary chatter return an empty signals list. NEVER invent "
    "signals — fabricated certainty is worse than silence. Use "
    "incorrect_claim only for clearly wrong technical claims.\n\n"
    "Recent messages:\n{context}\n\n"
    "Newest messages:\n{text}"
)

DRAFT_PROMPT = (
    "\nPressure has built for you to speak UNPROMPTED in the channel "
    "\"{channel}\" about \"{topic}\" (drive: {bucket}). The signals:\n"
    "{evidence}\n\nRecent conversation:\n{context}\n\n"
    "Decide honestly whether you have something NEW and genuinely useful to "
    "add. If not, decline — silence is fine. If yes, write the message in "
    "your usual voice: short, conversational, no markdown walls, at most 2 "
    "questions.\n"
    'Reply ONLY with JSON: {{"speak": true/false, "message": "...", '
    '"content_key": "slug-identifying-the-point", "relevance": 0.0-1.0}}'
)


def _parse_json(text: str) -> dict | None:
    """Tolerant JSON extraction (handles code fences and prose padding)."""
    try:
        start, end = text.index("{"), text.rindex("}") + 1
        return json.loads(text[start:end])
    except (ValueError, json.JSONDecodeError):
        return None


class Proactive(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.engines: dict[int, PressureEngine] = {}
        self.context: dict[int, deque] = defaultdict(lambda: deque(maxlen=CONTEXT_LINES))
        self.pending: dict[int, list[str]] = defaultdict(list)  # lines awaiting classify
        self.last_classify: dict[int, float] = {}
        self.ticker: asyncio.Task | None = None

    def engine(self, guild_id: int) -> PressureEngine:
        if guild_id not in self.engines:
            base = os.path.dirname(config.DATABASE_PATH) or "."
            path = os.path.join(base, f"pressure-{guild_id}.db")
            self.engines[guild_id] = PressureEngine(SqliteStore(path))
        return self.engines[guild_id]

    async def cog_load(self):
        self.ticker = asyncio.create_task(self._tick_loop())

    async def cog_unload(self):
        if self.ticker:
            self.ticker.cancel()

    # -- observation & classification ---------------------------------------

    @commands.Cog.listener()
    async def on_message(self, message: discord.Message):
        if message.guild is None:
            return
        now = time.time()
        engine = self.engine(message.guild.id)
        if message.author.bot:
            if message.author.id == self.bot.user.id:
                engine.observe_message(now, str(message.channel.id),
                                       str(message.author.id), is_self=True)
            return
        text = message.content.strip()
        self.context[message.channel.id].append(f"{message.author.display_name}: {text[:200]}")
        engine.observe_message(now, str(message.channel.id), str(message.author.id),
                               is_self=False)
        await self._classify_and_ingest(
            message.guild, message.channel.id, str(message.author.id),
            message.author.display_name, text, now)

    async def feed_voice(self, guild: discord.Guild, channel_id: int,
                         user_id: int, name: str, text: str):
        """Called by the Voice cog for each transcribed utterance."""
        now = time.time()
        engine = self.engine(guild.id)
        self.context[channel_id].append(f"{name} (voice): {text[:200]}")
        engine.observe_message(now, str(channel_id), str(user_id), is_self=False)
        await self._classify_and_ingest(guild, channel_id, str(user_id), name, text,
                                        now, confidence_scale=VOICE_CONFIDENCE_SCALE)

    async def _classify_and_ingest(self, guild, channel_id: int, user_id: str,
                                   author: str, text: str, now: float,
                                   confidence_scale: float = 1.0):
        if not await db.get_setting(guild.id, "pressure_enabled"):
            return
        if await db.get_setting(guild.id, "quiet_mode"):
            return
        if len(text) >= CLASSIFY_MIN_CHARS:
            self.pending[channel_id].append(f"{author}: {text[:300]}")
            del self.pending[channel_id][:-10]
        if not self.pending[channel_id]:
            return
        # Rate cap doubles as batching: everything since the last call goes
        # into one classification instead of one call per message.
        if now - self.last_classify.get(channel_id, 0) < CLASSIFY_MIN_INTERVAL:
            return
        self.last_classify[channel_id] = now
        batch = "\n".join(self.pending[channel_id])
        self.pending[channel_id] = []

        # ── HD pre-classification gate ──────────────────────────────────
        hd_scores = _hd_preclassify(batch)
        hd_scores_fmt = ", ".join(f"{k}={v:.4f}" for k, v in sorted(hd_scores.items()))
        has_signal = _hd_any_signal(hd_scores) if hd_scores else False
        log.info("HD preclassify [%s]: %s  signal=%s  thresh=%.4f",
                 channel_id, hd_scores_fmt, has_signal, _HD_SIM_THRESHOLD)
        if not has_signal:
            log.info("HD gate: skipping LLM classify for channel %s "
                     "(%.1fs since last, %d pending — all below SNR)",
                     channel_id, now - self.last_classify.get(channel_id, now), 0)
            return

        # ── LLM signal classification ───────────────────────────────────
        engine = self.engine(guild.id)
        prompt = CLASSIFY_PROMPT.format(
            sources=", ".join(engine.config.source_routing),
            context="\n".join(list(self.context[channel_id])[:-1]) or "(none)",
            text=batch,
        )
        try:
            reply = await openrouter.chat(
                [{"role": "user", "content": prompt}],
                model=await db.get_setting(guild.id, "ai_utility_model"),
                temperature=0.0, max_tokens=300, background=True,
            )
        except openrouter.OpenRouterError as exc:
            log.warning("Signal classification failed: %s", exc)
            return
        data = _parse_json(reply)
        if not data:
            return
        topic = str(data.get("topic") or "").strip().lower()[:60]
        if topic:
            engine.observe_message(now, str(channel_id), "", is_self=True, topic=topic)
        sources_seen = []
        for item in data.get("signals") or []:
            source = str(item.get("source", ""))
            sources_seen.append(source)
            try:
                confidence = float(item.get("confidence", 0)) * confidence_scale
            except (TypeError, ValueError):
                continue
            signal = Signal(
                key=f"{channel_id}:{source}:{topic}",
                source=source, weight=0, confidence=min(1.0, confidence),
                ts=now, topic=topic, channel_id=str(channel_id), user_id=user_id,
                evidence=str(item.get("evidence", ""))[:200],
            )
            if engine.ingest(signal, now):
                log.info("pressure signal %s(%s) conf=%.2f — %s",
                         source, topic, confidence, signal.evidence)

        # Safety signals nominate the de-escalation system; its own
        # context-validated gate decides whether Max actually says anything.
        if "safety_concern" in sources_seen:
            deesc = self.bot.get_cog("Deescalate")
            if deesc is not None:
                try:
                    await deesc.nominate(guild, channel_id)
                except Exception:
                    log.exception("de-escalation nomination failed")

    # -- tick & proactive speech ---------------------------------------------

    async def _tick_loop(self):
        while True:
            try:
                await asyncio.sleep(TICK_EVERY)
                now = time.time()
                for guild in self.bot.guilds:
                    engine = self.engines.get(guild.id)
                    if engine is None:
                        continue
                    engine.tick(now)
                    if (await db.get_setting(guild.id, "pressure_enabled")
                            and not await db.get_setting(guild.id, "quiet_mode")):
                        await self._maybe_speak(guild, engine, now)
            except asyncio.CancelledError:
                return
            except Exception:
                log.exception("Proactive tick failed")

    async def _maybe_speak(self, guild: discord.Guild, engine: PressureEngine, now: float):
        for cand in engine.candidates(now):
            if cand["pressure"] < cand["threshold"]:
                break  # sorted — nothing further is over threshold
            channel = guild.get_channel(int(cand["channel_id"] or 0))
            if channel is None:
                continue
            # cheap probe first: is the gate even open, before paying for a draft?
            probe = Proposal(
                topic=cand["topic"], bucket=cand["bucket"],
                content_key=f"probe-{int(now)}", summary="(probe)",
                relevance=1.0, channel_id=cand["channel_id"],
                user_id=cand["user_id"])
            if not engine.evaluate(probe, now, record=False).allowed:
                continue
            await self._draft_and_speak(guild, engine, channel, cand, now)
            return  # at most one proactive contribution per tick

    async def _draft_and_speak(self, guild, engine, channel, cand: dict, now: float):
        evidence = "\n".join(
            f"- {s.source}: {s.evidence or '(no detail)'}"
            for s in engine.store.signals("active")
            if s.topic == cand["topic"] and s.strength(now) > 0) or "(none)"
        ai_cog = self.bot.get_cog("AI")
        speaker_id = int(cand["user_id"]) if str(cand.get("user_id", "")).isdigit() else None
        system = await ai_cog.build_system_prompt(guild, speaker_id=speaker_id) if ai_cog else ""
        is_voice = isinstance(channel, discord.VoiceChannel)
        if is_voice and tts.fish_enabled():
            system += (voice_mod.FISH_S2_TAG_PROMPT if tts.is_s2()
                       else voice_mod.FISH_TAG_PROMPT)
        prompt = DRAFT_PROMPT.format(
            channel=channel.name, topic=cand["topic"], bucket=cand["bucket"],
            evidence=evidence,
            context="\n".join(self.context[channel.id]) or "(none)")
        try:
            reply = await openrouter.chat(
                [{"role": "system", "content": system},
                 {"role": "user", "content": prompt}],
                model=await db.get_setting(guild.id, "ai_model"),
                temperature=0.7, max_tokens=500,
            )
        except openrouter.OpenRouterError as exc:
            log.warning("Proactive draft failed: %s", exc)
            return
        data = _parse_json(reply)
        if not data or not data.get("speak") or not str(data.get("message", "")).strip():
            # the model itself declined — discharge so we don't re-draft every tick
            engine.resolve(now, "low_confidence", topic=cand["topic"])
            log.info("proactive draft declined for %s/%s", cand["bucket"], cand["topic"])
            return
        message = str(data["message"]).strip()
        display = tts.strip_voice_tags(message) or message
        proposal = Proposal(
            topic=cand["topic"], bucket=cand["bucket"],
            content_key=str(data.get("content_key") or f"{cand['topic']}-point")[:80],
            summary=display[:200],
            provides_new_info=True,
            question_count=message.count("?"),
            relevance=float(data.get("relevance", 0.0) or 0.0),
            channel_id=cand["channel_id"], user_id=cand["user_id"])
        decision = engine.evaluate(proposal, now)
        if not decision.allowed:
            log.info("gate held final draft (%s/%s): %s",
                     cand["bucket"], cand["topic"], "; ".join(decision.reasons))
            return
        try:
            for chunk in [display[i:i + 1990] for i in range(0, len(display), 1990)]:
                await channel.send(chunk)
        except discord.HTTPException as exc:
            log.warning("Proactive send failed: %s", exc)
            return
        engine.record_spoken(proposal, now)
        log.info("PROACTIVE (%s/%s in #%s): %s",
                 cand["bucket"], cand["topic"], channel.name, display[:120])

        # If this went to a voice channel, say it out loud too (tagged
        # version to TTS; the transcript console gets the clean text).
        if is_voice:
            voice_cog = self.bot.get_cog("Voice")
            if voice_cog is not None:
                try:
                    spoke = await voice_cog.speak_in_voice(guild, channel.id, message)
                    voice_cog.transcripts[channel.id].append(
                        {"ts": now, "name": self.bot.user.display_name,
                         "text": display, "bot": True})
                    if not spoke:
                        log.info("voice playback skipped (sidecar not in #%s)", channel.name)
                except Exception:
                    log.exception("Proactive voice playback failed")

    # -- owner visibility ----------------------------------------------------

    @app_commands.command(name="pressure",
                          description="Show or toggle the proactive pressure system")
    @app_commands.describe(enabled="Turn proactive speech on or off")
    @owner_only()
    async def pressure_cmd(self, interaction: discord.Interaction,
                           enabled: bool | None = None):
        if enabled is not None:
            await db.set_setting(interaction.guild.id, "pressure_enabled", enabled)
            await interaction.response.send_message(
                f"Proactive pressure {'enabled' if enabled else 'disabled'}.",
                ephemeral=True)
            return
        engine = self.engine(interaction.guild.id)
        snap = engine.snapshot(time.time())
        pressures = ", ".join(f"{k}={v:.2f}" for k, v in snap["pressures"].items()) or "none"
        signals = "\n".join(
            f"- {s['source']}({s['topic']}) {s['strength']:.2f}: {s['evidence'][:60]}"
            for s in snap["active_signals"][:10]) or "(none)"
        cooldowns = ", ".join(f"{k} {v:.0f}s" for k, v in snap["cooldowns"].items()) or "none"
        on = await db.get_setting(interaction.guild.id, "pressure_enabled")
        await interaction.response.send_message(
            f"**Proactive pressure** ({'on' if on else 'off'})\n"
            f"Pressures: {pressures}\nEnergy: {snap['energy']:.2f}\n"
            f"Cooldowns: {cooldowns}\nActive signals:\n{signals}"[:1990],
            ephemeral=True)


async def setup(bot: commands.Bot):
    await bot.add_cog(Proactive(bot))
