"""Automatic message moderation: banned words, invite links, mention spam,
and HD-based anomaly detection for raid / mention-storm / message-burst events.

Integrates ``DiscordSentinel`` from *sentinel_bridge* to feed server event
streams into a hyperdimensional adaptive baseline.  Events with anomaly scores
above ``QUARANTINE`` threshold trigger temporary mutes.
"""

import re
import time
from collections import defaultdict, deque

import discord
from discord.ext import commands

import db
from bot.utils import log_action
from sentinel_bridge import DiscordSentinel, ALPHA, ANOMALY_WARN, ANOMALY_QUARANTINE

INVITE_RE = re.compile(r"(discord\.gg/|discord(?:app)?\.com/invite/)", re.IGNORECASE)

# How many seconds of history to track for rate / mention-storm detection
RATE_WINDOW = 10  # seconds
RATE_THRESHOLD = 0.5  # msgs/sec above which → MESSAGE_BURST event
STORM_WINDOW = 10
STORM_SOURCE_THRESHOLD = 3  # unique mentioners in window → MENTION_STORM event
QUARANTINE_MINS = 10  # mute duration when QUARANTINE verdict fires

# temp-mute role name  (moderators create this role and assign it)
MUTED_ROLE_NAME = "muted"


class AutoMod(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        # Per-guild sentinel
        self._sentinels: dict[int, DiscordSentinel] = {}
        # Per-channel message timestamp deques for rate calculation
        self._msg_timestamps: dict[int, deque] = defaultdict(
            lambda: deque(maxlen=500)
        )
        # Per-target-user mention tracking: {target_id: deque[(source_id, ts)]}
        self._mention_log: dict[int, deque] = defaultdict(
            lambda: deque(maxlen=200)
        )
        # Track which members have been auto-muted to avoid re-muting
        self._auto_muted: set[int] = set()

    # -- helpers -------------------------------------------------------------

    def _sentinel(self, guild_id: int) -> DiscordSentinel:
        s = self._sentinels.get(guild_id)
        if s is None:
            s = DiscordSentinel()
            self._sentinels[guild_id] = s
        return s

    def _prune(self, dq: deque, window: int, now: float) -> None:
        """Drop entries older than *window* seconds from *dq*."""
        cutoff = now - window
        while dq and dq[0] < cutoff:
            dq.popleft()

    async def _mute(self, member: discord.Member, reason: str) -> bool:
        """Apply the muted role, returns True on success."""
        guild = member.guild
        role = discord.utils.get(guild.roles, name=MUTED_ROLE_NAME)
        if role is None:
            return False
        try:
            await member.add_roles(role, reason=reason)
            self._auto_muted.add(member.id)
            return True
        except discord.HTTPException:
            return False

    async def _quarantine(self, guild: discord.Guild, user_id: int, report: dict):
        """Apply quarantine action: temp-mute + log."""
        member = guild.get_member(user_id)
        if member is None or member.id in self._auto_muted:
            return
        ok = await self._mute(member, f"automod sentinel: {report['message']}")
        if ok:
            await log_action(
                guild, "sentinel",
                f"AutoMod (QUARANTINE)",
                member,
                f"{report['verdict']}: {report['message'][:200]}",
            )

    # -- listeners ------------------------------------------------------------

    @commands.Cog.listener()
    async def on_message(self, message: discord.Message):
        if message.guild is None or message.author.bot:
            return
        if isinstance(message.author, discord.Member) and \
                message.author.guild_permissions.manage_messages:
            return
        if not await db.get_setting(message.guild.id, "automod_enabled"):
            return

        sid = message.guild.id
        now = time.time()
        sentinel = self._sentinel(sid)

        # ── Existing rule-based checks ──────────────────────────────────
        violation = None
        content_lower = message.content.lower()
        banned_words = await db.get_setting(sid, "banned_words") or []
        for word in banned_words:
            if word and word.lower() in content_lower:
                violation = f"banned word: {word}"
                break
        if violation is None and await db.get_setting(sid, "block_invites"):
            if INVITE_RE.search(message.content):
                violation = "invite link"
        if violation is None:
            max_mentions = await db.get_setting(sid, "max_mentions") or 0
            if max_mentions and len(message.mentions) > int(max_mentions):
                violation = f"mention spam ({len(message.mentions)} mentions)"

        if violation is not None:
            try:
                await message.delete()
            except discord.HTTPException:
                return
            await log_action(message.guild, "automod", "AutoMod",
                             message.author, violation)
            try:
                await message.channel.send(
                    f"{message.author.mention}, your message was removed "
                    f"({violation}).", delete_after=6,
                )
            except discord.HTTPException:
                pass
            return

        # ── HD sentinel: message rate tracking ──────────────────────────
        ch_tss = self._msg_timestamps[message.channel.id]
        ch_tss.append(now)
        self._prune(ch_tss, RATE_WINDOW, now)
        if len(ch_tss) >= 3:  # at least 3 messages in the window
            rate = len(ch_tss) / min(RATE_WINDOW, now - ch_tss[0] + 1)
            if rate >= RATE_THRESHOLD:
                report = sentinel.observe(
                    "MESSAGE_BURST",
                    channel_id=str(message.channel.id),
                    rate=f"{rate:.2f}",
                    window_seconds=str(RATE_WINDOW),
                )
                if report["verdict"] == "QUARANTINE":
                    await self._quarantine(message.guild, message.author.id, report)

        # ── HD sentinel: mention storm tracking ─────────────────────────
        if message.mentions:
            for target in message.mentions:
                log = self._mention_log[target.id]
                log.append((message.author.id, now))
                self._prune(log, STORM_WINDOW, now)
                unique_sources = len({s for s, _ in log})
                if unique_sources >= STORM_SOURCE_THRESHOLD:
                    report = sentinel.observe(
                        "MENTION_STORM",
                        target_user_id=str(target.id),
                        mention_count=str(len(log)),
                        source_count=str(unique_sources),
                    )
                    if report["verdict"] == "QUARANTINE":
                        await self._quarantine(message.guild, message.author.id, report)

    @commands.Cog.listener()
    async def on_member_join(self, member: discord.Member):
        if member.guild is None or member.bot:
            return
        sentinel = self._sentinel(member.guild.id)
        mcount = len(member.guild.members)
        report = sentinel.observe(
            "MEMBER_JOIN",
            user_id=str(member.id),
            role_count=str(len(member.roles)),
        )
        if report["verdict"] == "QUARANTINE":
            await self._quarantine(member.guild, member.id, report)


async def setup(bot: commands.Bot):
    await bot.add_cog(AutoMod(bot))
