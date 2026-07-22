"""Discord bot client setup."""
import logging

import discord
from discord.ext import commands

import db

log = logging.getLogger("bot")

COGS = [
    "bot.cogs.moderation",
    "bot.cogs.roles",
    "bot.cogs.channels",
    "bot.cogs.welcome",
    "bot.cogs.automod",
    "bot.cogs.ai",
    "bot.cogs.utility",
]

ACTIVITY_TYPES = {
    "playing": discord.ActivityType.playing,
    "watching": discord.ActivityType.watching,
    "listening": discord.ActivityType.listening,
    "competing": discord.ActivityType.competing,
}

STATUSES = {
    "online": discord.Status.online,
    "idle": discord.Status.idle,
    "dnd": discord.Status.dnd,
    "invisible": discord.Status.invisible,
}


class DiscordAgent(commands.Bot):
    def __init__(self):
        intents = discord.Intents.default()
        intents.members = True
        intents.message_content = True
        super().__init__(command_prefix="!", intents=intents)
        self._synced = False

    async def setup_hook(self):
        for cog in COGS:
            await self.load_extension(cog)
        self.tree.on_error = self.on_app_command_error

    async def on_ready(self):
        log.info("Logged in as %s (%s) in %d guild(s)", self.user, self.user.id, len(self.guilds))
        if not self._synced:
            self._synced = True
            # Global sync, plus per-guild copies so commands show up immediately.
            await self.tree.sync()
            for guild in self.guilds:
                self.tree.copy_global_to(guild=guild)
                try:
                    await self.tree.sync(guild=guild)
                except discord.HTTPException:
                    log.warning("Failed to sync commands to guild %s", guild.id)
        await self.apply_presence()

    async def on_guild_join(self, guild: discord.Guild):
        self.tree.copy_global_to(guild=guild)
        try:
            await self.tree.sync(guild=guild)
        except discord.HTTPException:
            pass

    async def apply_presence(self):
        """Apply the presence stored in global settings (guild_id 0)."""
        status = STATUSES.get(await db.get_setting(0, "presence_status"), discord.Status.online)
        text = await db.get_setting(0, "presence_text")
        activity = None
        if text:
            activity_type = ACTIVITY_TYPES.get(
                await db.get_setting(0, "presence_activity_type"), discord.ActivityType.playing
            )
            activity = discord.Activity(type=activity_type, name=text)
        await self.change_presence(status=status, activity=activity)

    async def on_app_command_error(self, interaction: discord.Interaction, error):
        message = "Something went wrong running that command."
        if isinstance(error, discord.app_commands.MissingPermissions):
            message = "You don't have permission to use that command."
        elif isinstance(error, discord.app_commands.CommandInvokeError):
            original = error.original
            if isinstance(original, discord.Forbidden):
                message = "I don't have permission to do that. Check my role position and permissions."
            else:
                log.exception("Command error", exc_info=original)
        try:
            if interaction.response.is_done():
                await interaction.followup.send(message, ephemeral=True)
            else:
                await interaction.response.send_message(message, ephemeral=True)
        except discord.HTTPException:
            pass


bot = DiscordAgent()
