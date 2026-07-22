"""Welcome/goodbye messages and autorole, configured via the dashboard."""
import discord
from discord import app_commands
from discord.ext import commands

import db
from bot.utils import format_template


class Welcome(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    @commands.Cog.listener()
    async def on_member_join(self, member: discord.Member):
        guild = member.guild
        # autorole
        role_id = await db.get_setting(guild.id, "autorole")
        if role_id:
            role = guild.get_role(int(role_id))
            if role:
                try:
                    await member.add_roles(role, reason="Autorole")
                except discord.HTTPException:
                    pass
        # welcome message
        channel_id = await db.get_setting(guild.id, "welcome_channel")
        template = await db.get_setting(guild.id, "welcome_message")
        if channel_id and template:
            channel = guild.get_channel(int(channel_id))
            if channel:
                try:
                    await channel.send(format_template(template, member))
                except discord.HTTPException:
                    pass

    @commands.Cog.listener()
    async def on_member_remove(self, member: discord.Member):
        guild = member.guild
        channel_id = await db.get_setting(guild.id, "welcome_channel")
        template = await db.get_setting(guild.id, "goodbye_message")
        if channel_id and template:
            channel = guild.get_channel(int(channel_id))
            if channel:
                try:
                    await channel.send(format_template(template, member))
                except discord.HTTPException:
                    pass

    @app_commands.command(description="Preview the welcome message using yourself")
    @app_commands.default_permissions(manage_guild=True)
    async def testwelcome(self, interaction: discord.Interaction):
        template = await db.get_setting(interaction.guild.id, "welcome_message")
        await interaction.response.send_message(
            format_template(template, interaction.user), ephemeral=True)


async def setup(bot: commands.Bot):
    await bot.add_cog(Welcome(bot))
