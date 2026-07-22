"""Utility slash commands."""
import discord
from discord import app_commands
from discord.ext import commands

from bot.utils import owner_only


class Utility(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    @app_commands.command(description="Check the bot's latency")
    async def ping(self, interaction: discord.Interaction):
        await interaction.response.send_message(
            f"Pong! `{round(self.bot.latency * 1000)}ms`", ephemeral=True)

    @app_commands.command(description="Show info about this server")
    async def serverinfo(self, interaction: discord.Interaction):
        guild = interaction.guild
        embed = discord.Embed(title=guild.name, color=0x5865F2)
        if guild.icon:
            embed.set_thumbnail(url=guild.icon.url)
        embed.add_field(name="Owner", value=str(guild.owner))
        embed.add_field(name="Members", value=str(guild.member_count))
        embed.add_field(name="Channels", value=str(len(guild.channels)))
        embed.add_field(name="Roles", value=str(len(guild.roles)))
        embed.add_field(name="Boost level", value=str(guild.premium_tier))
        embed.add_field(name="Created", value=f"<t:{int(guild.created_at.timestamp())}:D>")
        await interaction.response.send_message(embed=embed)

    @app_commands.command(description="Show info about a member")
    @app_commands.describe(member="Member to look up (defaults to you)")
    async def userinfo(self, interaction: discord.Interaction, member: discord.Member | None = None):
        member = member or interaction.user
        embed = discord.Embed(title=str(member), color=member.colour)
        embed.set_thumbnail(url=member.display_avatar.url)
        embed.add_field(name="ID", value=str(member.id))
        embed.add_field(name="Joined", value=f"<t:{int(member.joined_at.timestamp())}:D>" if member.joined_at else "?")
        embed.add_field(name="Created", value=f"<t:{int(member.created_at.timestamp())}:D>")
        roles = [r.mention for r in member.roles if not r.is_default()]
        embed.add_field(name=f"Roles ({len(roles)})", value=" ".join(roles[:15]) or "None", inline=False)
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @app_commands.command(description="Make the bot say something in a channel")
    @app_commands.describe(message="What the bot should say",
                           channel="Channel to send to (defaults to current)")
    @app_commands.default_permissions(manage_messages=True)
    @owner_only()
    async def say(self, interaction: discord.Interaction, message: str,
                  channel: discord.TextChannel | None = None):
        target = channel or interaction.channel
        await target.send(message)
        await interaction.response.send_message(f"Sent to {target.mention}.", ephemeral=True)


async def setup(bot: commands.Bot):
    await bot.add_cog(Utility(bot))
