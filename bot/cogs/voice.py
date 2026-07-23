"""Voice monitoring pipeline — the Python half of the hybrid voice system.

Audio capture lives in the Node.js sidecar (listener/): discord.js's voice
stack speaks Discord's DAVE E2EE protocol, which no Python library does yet.
The sidecar logs in with the same bot token (a second gateway session),
auto-joins occupied voice channels, receives each speaker's decrypted audio
as a separate stream, cuts utterances on ~1s of silence, and POSTs raw PCM
to the internal API (web/internal.py), which calls into this cog.

This cog owns the content side: transcription, rolling per-channel
transcripts, banned-word flags to the mod log, and wake-word responses —
the text reply is posted to the channel here, and TTS audio is returned to
the sidecar for playback in the voice channel.
"""
import asyncio
import base64
import logging
import time
from collections import defaultdict, deque

import discord
import httpx
from discord import app_commands
from discord.ext import commands

import config
import db
import openrouter
import tools
import transcription
from bot.utils import log_action, owner_only

log = logging.getLogger("voice")

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
        self.last_wake: dict[int, float] = {}
        self.stt_sem = asyncio.Semaphore(MAX_CONCURRENT_STT)
        if not transcription.available():
            log.warning("TRANSCRIPTION_API_KEY not set — voice monitoring disabled")

    async def _wake_words(self, guild_id: int) -> list[str]:
        words = await db.get_setting(guild_id, "voice_wake_words") or []
        return [w.lower() for w in words if w.strip()]

    # -- sidecar-facing API (called from web/internal.py) --------------------

    async def voice_config(self, guild_id: int) -> dict:
        enabled = bool(await db.get_setting(guild_id, "voice_enabled"))
        return {
            "enabled": enabled and transcription.available(),
            "wake_words": await self._wake_words(guild_id),
        }

    async def handle_event(self, guild_id: int, channel_id: int, event: str):
        if event == "left":
            self.transcripts.pop(channel_id, None)
            return
        if event != "joined":
            return
        guild = self.bot.get_guild(guild_id)
        channel = guild.get_channel(channel_id) if guild else None
        if channel is None:
            return
        wake = await self._wake_words(guild_id)
        hint = f' Say "{wake[0]}" to bring me into the conversation.' if wake else ""
        try:
            await channel.send(
                "🎙️ Heads-up: an AI is listening to this channel and transcribing "
                f"speech for moderation.{hint}"
            )
        except discord.HTTPException:
            pass

    async def handle_utterance(self, guild_id: int, channel_id: int,
                               user_id: int, pcm: bytes) -> dict:
        guild = self.bot.get_guild(guild_id)
        if guild is None:
            return {}
        channel = guild.get_channel(channel_id)
        member = guild.get_member(user_id)
        if channel is None or (member and member.bot):
            return {}
        name = member.display_name if member else f"user-{user_id}"

        async with self.stt_sem:
            text = await transcription.transcribe_pcm(pcm)
        if not text:
            return {}
        log.info("[%s] %s: %s", channel.name, name, text)
        self.transcripts[channel_id].append((name, text))

        await self._check_banned_words(guild, channel, name, text)

        tts = None
        wake = await self._wake_words(guild_id)
        normalized = " ".join("".join(c if c.isalnum() else " " for c in text.lower()).split())
        if any(w in normalized for w in wake):
            tts = await self._respond(channel, name)
        return {"text": text, "tts": tts}

    async def _check_banned_words(self, guild, channel, speaker_name, text):
        banned = await db.get_setting(guild.id, "banned_words") or []
        lowered = text.lower()
        hits = [w for w in banned if w.lower() in lowered]
        if hits:
            await log_action(
                guild, "voice_flag", "voice automod",
                f"{speaker_name} in #{channel.name}",
                f"said {', '.join(hits)!r}: “{text[:180]}”",
            )

    # -- wake-word response ---------------------------------------------------

    async def _respond(self, channel, speaker_name: str) -> str | None:
        """Reply in the channel's text chat; return TTS mp3 (base64) for playback."""
        now = time.monotonic()
        if now - self.last_wake.get(channel.id, 0) < WAKE_COOLDOWN:
            return None
        self.last_wake[channel.id] = now

        guild = channel.guild
        ai_cog = self.bot.get_cog("AI")
        base_prompt = await ai_cog.build_system_prompt(guild) if ai_cog else ""
        system_prompt = base_prompt + VOICE_PROMPT.format(
            channel=channel.name, speaker=speaker_name
        )
        lines = list(self.transcripts[channel.id])[-CONTEXT_LINES:]
        transcript = "\n".join(f"{n}: {t}" for n, t in lines)
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
            return None
        if not reply:
            return None
        self.transcripts[channel.id].append((self.bot.user.display_name, reply))
        try:
            for chunk in [reply[i:i + 1990] for i in range(0, len(reply), 1990)]:
                await channel.send(chunk)
        except discord.HTTPException:
            pass
        return await self._tts(reply)

    async def _tts(self, text: str) -> str | None:
        """Generate TTS mp3 via edge-tts, base64-encoded for the sidecar."""
        try:
            import edge_tts

            buf = bytearray()
            async for chunk in edge_tts.Communicate(text[:800], voice="en-US-GuyNeural").stream():
                if chunk["type"] == "audio":
                    buf += chunk["data"]
            return base64.b64encode(bytes(buf)).decode() if buf else None
        except Exception as exc:
            log.info("TTS unavailable (%s) — text reply only", exc)
            return None

    # -- owner commands (proxied to the sidecar's control API) ----------------

    async def _sidecar(self, method: str, path: str, payload: dict | None = None) -> dict:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.request(
                method, config.SIDECAR_URL + path, json=payload,
                headers={"x-internal-key": config.SECRET_KEY},
            )
        resp.raise_for_status()
        return resp.json()

    @app_commands.command(description="Make the bot join your voice channel and listen")
    @owner_only()
    async def voicejoin(self, interaction: discord.Interaction):
        if not transcription.available():
            await interaction.response.send_message(
                "Voice monitoring isn't available (TRANSCRIPTION_API_KEY not set).", ephemeral=True)
            return
        state = interaction.user.voice
        if state is None or state.channel is None:
            await interaction.response.send_message("You're not in a voice channel.", ephemeral=True)
            return
        await interaction.response.defer(ephemeral=True)
        try:
            await self._sidecar("POST", "/join", {
                "guild_id": str(interaction.guild.id), "channel_id": str(state.channel.id)})
        except (httpx.HTTPError, ValueError) as exc:
            await interaction.followup.send(f"Voice listener unreachable: {exc}")
            return
        await interaction.followup.send(f"Listening in **{state.channel.name}**.")

    @app_commands.command(description="Make the bot leave voice")
    @owner_only()
    async def voiceleave(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)
        try:
            await self._sidecar("POST", "/leave", {"guild_id": str(interaction.guild.id)})
        except (httpx.HTTPError, ValueError) as exc:
            await interaction.followup.send(f"Voice listener unreachable: {exc}")
            return
        await interaction.followup.send("Left voice.")

    @app_commands.command(description="Set the voice wake words (comma-separated)")
    @app_commands.describe(words='e.g. "hey max, hey andrew"')
    @owner_only()
    async def wakewords(self, interaction: discord.Interaction, words: str):
        parsed = [w.strip().lower() for w in words.split(",") if w.strip()]
        await db.set_setting(interaction.guild.id, "voice_wake_words", parsed)
        await interaction.response.send_message(
            f"Wake words set to: {', '.join(parsed) or '(none)'}", ephemeral=True)


async def setup(bot: commands.Bot):
    await bot.add_cog(Voice(bot))
