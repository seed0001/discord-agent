"""Voice channel monitoring: per-user transcription, moderation flags, wake words.

When someone joins a voice channel, the bot joins too and listens. Discord
delivers every speaker's audio as a separate stream, so each user gets their
own buffer: audio accumulates until ~1s of silence ends the utterance, which
is then transcribed. Transcripts feed a rolling per-channel log that:

- gets checked against the banned_words list (flags go to the mod log), and
- triggers the AI to join the conversation when a wake word is heard,
  with the full transcript as context.

Requires TRANSCRIPTION_API_KEY (OpenAI-compatible /audio/transcriptions).
One bot account = one voice channel per guild at a time.
"""
import asyncio
import logging
import threading
import time
from collections import defaultdict, deque

import discord
from discord import app_commands
from discord.ext import commands

try:
    from discord.ext import voice_recv
    VOICE_RECV_ERROR = None
except Exception as exc:  # missing dep or opus lib — cog stays inert
    voice_recv = None
    VOICE_RECV_ERROR = exc

import db
import openrouter
import tools
import transcription
from bot.utils import is_owner, log_action, owner_only

log = logging.getLogger("voice")


def _ensure_opus() -> bool:
    """Load libopus for voice decode, searching beyond ctypes' default paths
    (nix store, common lib dirs) since managed builds put it in odd places."""
    if discord.opus.is_loaded():
        return True
    try:
        discord.opus._load_default()
    except Exception:
        pass
    if discord.opus.is_loaded():
        return True
    import ctypes.util
    import glob

    candidates = []
    found = ctypes.util.find_library("opus")
    if found:
        candidates.append(found)
    for pattern in (
        "/usr/lib/x86_64-linux-gnu/libopus.so*",
        "/usr/lib/**/libopus.so*",
        "/nix/store/*opus*/lib/libopus.so*",
    ):
        candidates.extend(sorted(glob.glob(pattern, recursive=True)))
    for path in candidates:
        try:
            discord.opus.load_opus(path)
            log.info("Loaded opus from %s", path)
            return True
        except Exception:
            continue
    return False

PCM_BYTES_PER_SEC = 48000 * 2 * 2  # 48kHz, 16-bit, stereo
SILENCE_FLUSH = 1.0       # seconds of silence that ends an utterance
MIN_UTTERANCE_SEC = 0.4   # drop blips shorter than this
MAX_UTTERANCE_SEC = 45    # force-flush marathon monologues
TRANSCRIPT_LINES = 300    # rolling transcript kept per channel
CONTEXT_LINES = 40        # transcript lines the AI sees on wake
WAKE_COOLDOWN = 8         # seconds between wake responses per channel
MAX_CONCURRENT_STT = 4    # simultaneous transcription API calls

VOICE_PROMPT = (
    "\nRight now you are LIVE in the voice channel \"{channel}\" — you've been "
    "listening and the transcript below is what's been said (transcription may "
    "have small errors; roll with obvious ones). {speaker} just addressed you "
    "by your wake word. Jump into the conversation: you know the context, the "
    "positions people have taken, and the vibe. Weigh in directly and "
    "conversationally — this will be read (and maybe spoken) aloud in the "
    "channel, so keep it tight, no markdown, no walls of text."
)


class Voice(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        # channel_id -> deque[(speaker_name, text)]
        self.transcripts: dict[int, deque] = defaultdict(lambda: deque(maxlen=TRANSCRIPT_LINES))
        # user_id -> {"member": Member, "pcm": bytearray, "last": monotonic}
        self.buffers: dict[int, dict] = {}
        self.buf_lock = threading.Lock()
        self.last_wake: dict[int, float] = {}
        self.stt_sem = asyncio.Semaphore(MAX_CONCURRENT_STT)
        self.flusher: asyncio.Task | None = None
        if voice_recv is None:
            log.error("Voice receive unavailable (%s) — voice monitoring disabled", VOICE_RECV_ERROR)
        elif not transcription.available():
            log.warning("TRANSCRIPTION_API_KEY not set — voice monitoring disabled")

    def enabled(self) -> bool:
        return (voice_recv is not None and transcription.available()
                and discord.opus.is_loaded())

    async def cog_load(self):
        self.flusher = asyncio.create_task(self._flush_loop())

    async def cog_unload(self):
        if self.flusher:
            self.flusher.cancel()

    # -- join/leave orchestration -------------------------------------------

    @staticmethod
    def _humans(channel: discord.VoiceChannel) -> list[discord.Member]:
        return [m for m in channel.members if not m.bot]

    async def _wake_words(self, guild_id: int) -> list[str]:
        words = await db.get_setting(guild_id, "voice_wake_words") or []
        return [w.lower() for w in words if w.strip()]

    async def _join(self, channel: discord.VoiceChannel):
        try:
            vc = await channel.connect(cls=voice_recv.VoiceRecvClient)
            vc.listen(voice_recv.BasicSink(self._on_packet))
        except Exception:
            log.exception("Failed to join voice channel %s", channel.id)
            return
        log.info("Listening in voice channel #%s (%s)", channel.name, channel.id)
        wake = await self._wake_words(channel.guild.id)
        hint = f' Say "{wake[0]}" to bring me into the conversation.' if wake else ""
        try:
            await channel.send(
                "🎙️ Heads-up: an AI is listening to this channel and transcribing "
                f"speech for moderation.{hint}"
            )
        except discord.HTTPException:
            pass

    async def _leave(self, guild: discord.Guild):
        vc = guild.voice_client
        if vc is not None:
            channel_id = vc.channel.id if vc.channel else None
            try:
                await vc.disconnect(force=True)
            except Exception:
                log.exception("Error disconnecting from voice in guild %s", guild.id)
            if channel_id:
                self.transcripts.pop(channel_id, None)
        with self.buf_lock:
            for uid in [u for u, b in self.buffers.items() if b["member"].guild.id == guild.id]:
                self.buffers.pop(uid, None)

    async def _rebalance(self, guild: discord.Guild):
        """Keep the bot in the busiest occupied voice channel; leave when all empty."""
        if not self.enabled() or not await db.get_setting(guild.id, "voice_enabled"):
            return
        vc = guild.voice_client
        if vc is not None and vc.channel and self._humans(vc.channel):
            return  # current channel still occupied — stay put
        occupied = sorted(
            (c for c in guild.voice_channels if self._humans(c)),
            key=lambda c: -len(self._humans(c)),
        )
        if vc is not None:
            await self._leave(guild)
        if occupied:
            await self._join(occupied[0])

    @commands.Cog.listener()
    async def on_voice_state_update(self, member, before, after):
        if member.bot:
            return
        await self._rebalance(member.guild)

    @commands.Cog.listener()
    async def on_ready(self):
        for guild in self.bot.guilds:
            await self._rebalance(guild)

    # -- audio pipeline ------------------------------------------------------

    def _on_packet(self, user, data):
        """Called from voice-recv's decode thread for every ~20ms audio packet."""
        if user is None or getattr(user, "bot", False):
            return
        pcm = getattr(data, "pcm", None)
        if not pcm:
            return
        with self.buf_lock:
            buf = self.buffers.get(user.id)
            if buf is None:
                buf = self.buffers[user.id] = {"member": user, "pcm": bytearray(), "last": 0.0}
            buf["pcm"] += pcm
            buf["last"] = time.monotonic()

    async def _flush_loop(self):
        """Turn silence gaps into utterance boundaries and dispatch transcription."""
        while True:
            try:
                await asyncio.sleep(0.3)
                now = time.monotonic()
                ready = []
                with self.buf_lock:
                    for buf in self.buffers.values():
                        if not buf["pcm"]:
                            continue
                        duration = len(buf["pcm"]) / PCM_BYTES_PER_SEC
                        if now - buf["last"] >= SILENCE_FLUSH or duration >= MAX_UTTERANCE_SEC:
                            pcm = bytes(buf["pcm"])
                            buf["pcm"] = bytearray()
                            if duration >= MIN_UTTERANCE_SEC:
                                ready.append((buf["member"], pcm))
                for member, pcm in ready:
                    asyncio.create_task(self._handle_utterance(member, pcm))
            except asyncio.CancelledError:
                return
            except Exception:
                log.exception("Voice flush loop error")

    async def _handle_utterance(self, member: discord.Member, pcm: bytes):
        guild = member.guild
        vc = guild.voice_client
        if vc is None or vc.channel is None:
            return
        channel = vc.channel
        async with self.stt_sem:
            text = await transcription.transcribe_pcm(pcm)
        if not text:
            return
        log.info("[%s] %s: %s", channel.name, member.display_name, text)
        self.transcripts[channel.id].append((member.display_name, text))

        await self._check_banned_words(guild, channel, member, text)

        wake = await self._wake_words(guild.id)
        normalized = " ".join("".join(c if c.isalnum() else " " for c in text.lower()).split())
        if any(w in normalized for w in wake):
            await self._respond(channel, member, text)

    async def _check_banned_words(self, guild, channel, member, text):
        banned = await db.get_setting(guild.id, "banned_words") or []
        lowered = text.lower()
        hits = [w for w in banned if w.lower() in lowered]
        if hits:
            await log_action(
                guild, "voice_flag", "voice automod",
                f"{member} in #{channel.name}",
                f"said {', '.join(hits)!r}: “{text[:180]}”",
            )

    # -- wake-word response --------------------------------------------------

    async def _respond(self, channel: discord.VoiceChannel, member: discord.Member, text: str):
        now = time.monotonic()
        if now - self.last_wake.get(channel.id, 0) < WAKE_COOLDOWN:
            return
        self.last_wake[channel.id] = now

        guild = channel.guild
        ai_cog = self.bot.get_cog("AI")
        base_prompt = await ai_cog.build_system_prompt(guild) if ai_cog else ""
        system_prompt = base_prompt + VOICE_PROMPT.format(
            channel=channel.name, speaker=member.display_name
        )
        lines = list(self.transcripts[channel.id])[-CONTEXT_LINES:]
        transcript = "\n".join(f"{name}: {t}" for name, t in lines) or f"{member.display_name}: {text}"
        model = await db.get_setting(guild.id, "ai_model")
        try:
            reply = await openrouter.chat(
                [{"role": "system", "content": system_prompt},
                 {"role": "user", "content": f"[voice transcript of #{channel.name}]\n{transcript}"}],
                model=model,
                tools=tools.TOOL_SCHEMAS, tool_handler=tools.run_tool,
            )
        except openrouter.OpenRouterError as exc:
            log.warning("Wake response failed: %s", exc)
            return
        if not reply:
            return
        self.transcripts[channel.id].append((self.bot.user.display_name, reply))
        try:
            for chunk in [reply[i:i + 1990] for i in range(0, len(reply), 1990)]:
                await channel.send(chunk)
        except discord.HTTPException:
            pass
        await self._speak(guild.voice_client, reply)

    async def _speak(self, vc, text: str):
        """Best-effort TTS via edge-tts; silently skipped if unavailable."""
        if vc is None or vc.is_playing():
            return
        try:
            import tempfile

            import edge_tts

            tmp = tempfile.NamedTemporaryFile(suffix=".mp3", delete=False)
            tmp.close()
            await edge_tts.Communicate(text[:800], voice="en-US-GuyNeural").save(tmp.name)
            source = await discord.FFmpegOpusAudio.from_probe(tmp.name)
            vc.play(source)
        except Exception as exc:
            log.info("TTS unavailable (%s) — text reply only", exc)

    # -- owner commands ------------------------------------------------------

    @app_commands.command(description="Make the bot join your voice channel and listen")
    @owner_only()
    async def voicejoin(self, interaction: discord.Interaction):
        if not self.enabled():
            await interaction.response.send_message(
                "Voice monitoring isn't available (missing voice-recv/opus or TRANSCRIPTION_API_KEY).",
                ephemeral=True)
            return
        state = interaction.user.voice
        if state is None or state.channel is None:
            await interaction.response.send_message("You're not in a voice channel.", ephemeral=True)
            return
        if interaction.guild.voice_client is not None:
            await self._leave(interaction.guild)
        await self._join(state.channel)
        await interaction.response.send_message(f"Listening in **{state.channel.name}**.", ephemeral=True)

    @app_commands.command(description="Make the bot leave voice")
    @owner_only()
    async def voiceleave(self, interaction: discord.Interaction):
        await self._leave(interaction.guild)
        await interaction.response.send_message("Left voice.", ephemeral=True)

    @app_commands.command(description="Set the voice wake words (comma-separated)")
    @app_commands.describe(words='e.g. "hey max, hey andrew"')
    @owner_only()
    async def wakewords(self, interaction: discord.Interaction, words: str):
        parsed = [w.strip().lower() for w in words.split(",") if w.strip()]
        await db.set_setting(interaction.guild.id, "voice_wake_words", parsed)
        await interaction.response.send_message(
            f"Wake words set to: {', '.join(parsed) or '(none)'}", ephemeral=True)


async def setup(bot: commands.Bot):
    if voice_recv is not None and not _ensure_opus():
        log.error("libopus not found — voice monitoring disabled "
                  "(install libopus0 / add it to nixpacks.toml)")
    await bot.add_cog(Voice(bot))
