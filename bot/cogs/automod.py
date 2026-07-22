"""Automatic message moderation: banned words, invite links, mention spam."""
import re

import discord
from discord.ext import commands

import db
from bot.utils import log_action

INVITE_RE = re.compile(r"(discord\.gg/|discord(?:app)?\.com/invite/)", re.IGNORECASE)


class AutoMod(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    @commands.Cog.listener()
    async def on_message(self, message: discord.Message):
        if message.guild is None or message.author.bot:
            return
        if isinstance(message.author, discord.Member) and \
                message.author.guild_permissions.manage_messages:
            return
        if not await db.get_setting(message.guild.id, "automod_enabled"):
            return

        violation = None
        content_lower = message.content.lower()

        banned_words = await db.get_setting(message.guild.id, "banned_words") or []
        for word in banned_words:
            if word and word.lower() in content_lower:
                violation = f"banned word: {word}"
                break

        if violation is None and await db.get_setting(message.guild.id, "block_invites"):
            if INVITE_RE.search(message.content):
                violation = "invite link"

        if violation is None:
            max_mentions = await db.get_setting(message.guild.id, "max_mentions") or 0
            if max_mentions and len(message.mentions) > int(max_mentions):
                violation = f"mention spam ({len(message.mentions)} mentions)"

        if violation is None:
            return

        try:
            await message.delete()
        except discord.HTTPException:
            return
        await log_action(message.guild, "automod", "AutoMod", message.author, violation)
        try:
            await message.channel.send(
                f"{message.author.mention}, your message was removed ({violation}).",
                delete_after=6,
            )
        except discord.HTTPException:
            pass


async def setup(bot: commands.Bot):
    await bot.add_cog(AutoMod(bot))
