"""Channel management slash commands."""
import discord
from discord import app_commands
from discord.ext import commands

from bot.utils import is_owner, log_action


class Channels(commands.Cog):
    """All commands in this cog are restricted to the bot owner (OWNER_ID)."""

    def __init__(self, bot: commands.Bot):
        self.bot = bot

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return is_owner(interaction.user.id)

    @app_commands.command(description="Create a channel")
    @app_commands.describe(name="Channel name", kind="Channel type")
    @app_commands.choices(kind=[
        app_commands.Choice(name="Text", value="text"),
        app_commands.Choice(name="Voice", value="voice"),
        app_commands.Choice(name="Category", value="category"),
    ])
    @app_commands.default_permissions(manage_channels=True)
    async def createchannel(self, interaction: discord.Interaction, name: str, kind: str = "text"):
        guild = interaction.guild
        if kind == "voice":
            channel = await guild.create_voice_channel(name)
        elif kind == "category":
            channel = await guild.create_category(name)
        else:
            channel = await guild.create_text_channel(name)
        await log_action(guild, "channel_create", interaction.user, channel.name, kind)
        await interaction.response.send_message(f"Created {kind} channel **{channel.name}**.", ephemeral=True)

    @app_commands.command(description="Delete a channel")
    @app_commands.describe(channel="Channel to delete")
    @app_commands.default_permissions(manage_channels=True)
    async def deletechannel(self, interaction: discord.Interaction, channel: discord.abc.GuildChannel):
        name = channel.name
        await channel.delete()
        await log_action(interaction.guild, "channel_delete", interaction.user, name, None)
        await interaction.response.send_message(f"Deleted channel **{name}**.", ephemeral=True)

    @app_commands.command(description="Set the topic of a text channel")
    @app_commands.describe(channel="Channel to edit (defaults to current)", topic="New topic")
    @app_commands.default_permissions(manage_channels=True)
    async def settopic(self, interaction: discord.Interaction, topic: str,
                       channel: discord.TextChannel | None = None):
        target = channel or interaction.channel
        await target.edit(topic=topic)
        await interaction.response.send_message(f"Updated topic for {target.mention}.", ephemeral=True)


async def setup(bot: commands.Bot):
    await bot.add_cog(Channels(bot))
