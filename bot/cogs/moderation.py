"""Moderation slash commands: kick, ban, timeout, warn, purge, lock, slowmode."""
from datetime import timedelta

import discord
from discord import app_commands
from discord.ext import commands

import db
from bot.utils import is_owner, log_action


class Moderation(commands.Cog):
    """All commands in this cog are restricted to the bot owner (OWNER_ID)."""

    def __init__(self, bot: commands.Bot):
        self.bot = bot

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return is_owner(interaction.user.id)

    @app_commands.command(description="Kick a member from the server")
    @app_commands.describe(member="Member to kick", reason="Reason for the kick")
    @app_commands.default_permissions(kick_members=True)
    async def kick(self, interaction: discord.Interaction, member: discord.Member, reason: str | None = None):
        await member.kick(reason=reason)
        await log_action(interaction.guild, "kick", interaction.user, member, reason)
        await interaction.response.send_message(f"Kicked **{member}**.", ephemeral=True)

    @app_commands.command(description="Ban a member from the server")
    @app_commands.describe(member="Member to ban", reason="Reason for the ban",
                           delete_days="Days of their messages to delete (0-7)")
    @app_commands.default_permissions(ban_members=True)
    async def ban(self, interaction: discord.Interaction, member: discord.Member,
                  reason: str | None = None, delete_days: app_commands.Range[int, 0, 7] = 0):
        await member.ban(reason=reason, delete_message_seconds=delete_days * 86400)
        await log_action(interaction.guild, "ban", interaction.user, member, reason)
        await interaction.response.send_message(f"Banned **{member}**.", ephemeral=True)

    @app_commands.command(description="Unban a user by their ID")
    @app_commands.describe(user_id="ID of the user to unban", reason="Reason for the unban")
    @app_commands.default_permissions(ban_members=True)
    async def unban(self, interaction: discord.Interaction, user_id: str, reason: str | None = None):
        try:
            user = discord.Object(id=int(user_id))
        except ValueError:
            await interaction.response.send_message("That's not a valid user ID.", ephemeral=True)
            return
        await interaction.guild.unban(user, reason=reason)
        await log_action(interaction.guild, "unban", interaction.user, user_id, reason)
        await interaction.response.send_message(f"Unbanned user `{user_id}`.", ephemeral=True)

    @app_commands.command(description="Timeout a member")
    @app_commands.describe(member="Member to timeout", minutes="Duration in minutes (max 40320 = 28 days)",
                           reason="Reason for the timeout")
    @app_commands.default_permissions(moderate_members=True)
    async def timeout(self, interaction: discord.Interaction, member: discord.Member,
                      minutes: app_commands.Range[int, 1, 40320], reason: str | None = None):
        await member.timeout(timedelta(minutes=minutes), reason=reason)
        await log_action(interaction.guild, "timeout", interaction.user, member,
                         f"{reason or 'No reason'} ({minutes}m)")
        await interaction.response.send_message(
            f"Timed out **{member}** for {minutes} minute(s).", ephemeral=True)

    @app_commands.command(description="Remove a member's timeout")
    @app_commands.describe(member="Member to remove the timeout from")
    @app_commands.default_permissions(moderate_members=True)
    async def untimeout(self, interaction: discord.Interaction, member: discord.Member):
        await member.timeout(None)
        await log_action(interaction.guild, "untimeout", interaction.user, member, None)
        await interaction.response.send_message(f"Removed timeout for **{member}**.", ephemeral=True)

    @app_commands.command(description="Warn a member")
    @app_commands.describe(member="Member to warn", reason="Reason for the warning")
    @app_commands.default_permissions(moderate_members=True)
    async def warn(self, interaction: discord.Interaction, member: discord.Member, reason: str):
        await db.add_warning(interaction.guild.id, member.id, interaction.user.id, reason)
        await log_action(interaction.guild, "warn", interaction.user, member, reason)
        count = len(await db.get_warnings(interaction.guild.id, member.id))
        try:
            await member.send(f"You were warned in **{interaction.guild.name}**: {reason}")
        except discord.HTTPException:
            pass
        await interaction.response.send_message(
            f"Warned **{member}** (warning #{count}).", ephemeral=True)

    @app_commands.command(description="List a member's warnings")
    @app_commands.describe(member="Member whose warnings to show")
    @app_commands.default_permissions(moderate_members=True)
    async def warnings(self, interaction: discord.Interaction, member: discord.Member):
        rows = await db.get_warnings(interaction.guild.id, member.id)
        if not rows:
            await interaction.response.send_message(f"**{member}** has no warnings.", ephemeral=True)
            return
        lines = [
            f"`#{r['id']}` <t:{r['created_at']}:R> — {r['reason'] or 'No reason'}"
            for r in rows[:15]
        ]
        embed = discord.Embed(title=f"Warnings for {member} ({len(rows)})",
                              description="\n".join(lines), color=0xF0B232)
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @app_commands.command(description="Clear all warnings for a member")
    @app_commands.describe(member="Member whose warnings to clear")
    @app_commands.default_permissions(moderate_members=True)
    async def clearwarnings(self, interaction: discord.Interaction, member: discord.Member):
        count = await db.clear_warnings(interaction.guild.id, member.id)
        await log_action(interaction.guild, "clear_warnings", interaction.user, member, f"{count} removed")
        await interaction.response.send_message(
            f"Cleared {count} warning(s) for **{member}**.", ephemeral=True)

    @app_commands.command(description="Delete recent messages in this channel")
    @app_commands.describe(amount="Number of messages to delete (1-100)")
    @app_commands.default_permissions(manage_messages=True)
    async def purge(self, interaction: discord.Interaction, amount: app_commands.Range[int, 1, 100]):
        await interaction.response.defer(ephemeral=True)
        deleted = await interaction.channel.purge(limit=amount)
        await log_action(interaction.guild, "purge", interaction.user,
                         f"#{interaction.channel.name}", f"{len(deleted)} messages")
        await interaction.followup.send(f"Deleted {len(deleted)} message(s).", ephemeral=True)

    @app_commands.command(description="Set slowmode for this channel")
    @app_commands.describe(seconds="Seconds between messages (0 to disable, max 21600)")
    @app_commands.default_permissions(manage_channels=True)
    async def slowmode(self, interaction: discord.Interaction, seconds: app_commands.Range[int, 0, 21600]):
        await interaction.channel.edit(slowmode_delay=seconds)
        await interaction.response.send_message(
            f"Slowmode set to {seconds}s." if seconds else "Slowmode disabled.", ephemeral=True)

    @app_commands.command(description="Lock this channel (prevent @everyone from sending messages)")
    @app_commands.default_permissions(manage_channels=True)
    async def lock(self, interaction: discord.Interaction):
        await interaction.channel.set_permissions(interaction.guild.default_role, send_messages=False)
        await log_action(interaction.guild, "lock", interaction.user, f"#{interaction.channel.name}", None)
        await interaction.response.send_message("Channel locked.", ephemeral=True)

    @app_commands.command(description="Unlock this channel")
    @app_commands.default_permissions(manage_channels=True)
    async def unlock(self, interaction: discord.Interaction):
        await interaction.channel.set_permissions(interaction.guild.default_role, send_messages=None)
        await log_action(interaction.guild, "unlock", interaction.user, f"#{interaction.channel.name}", None)
        await interaction.response.send_message("Channel unlocked.", ephemeral=True)


async def setup(bot: commands.Bot):
    await bot.add_cog(Moderation(bot))
