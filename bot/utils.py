"""Shared helpers for the bot."""
import discord
from discord import app_commands

import config
import db


def is_owner(user_id: int) -> bool:
    """True if user_id is the configured bot owner (OWNER_ID env var)."""
    return bool(config.OWNER_ID) and user_id == config.OWNER_ID


def owner_only():
    """App-command check restricting a command to the bot owner."""
    def predicate(interaction: discord.Interaction) -> bool:
        return is_owner(interaction.user.id)
    return app_commands.check(predicate)

ACTION_COLORS = {
    "kick": 0xF0B232,
    "ban": 0xDA373C,
    "unban": 0x23A559,
    "timeout": 0xF0B232,
    "untimeout": 0x23A559,
    "warn": 0xF0B232,
    "purge": 0x5865F2,
    "automod": 0xDA373C,
    "voice_flag": 0xDA373C,
}


async def log_action(
    guild: discord.Guild,
    action: str,
    actor,
    target=None,
    reason: str | None = None,
) -> None:
    """Record a moderation action to the database and the configured log channel."""
    await db.add_log(
        guild.id,
        action,
        str(actor),
        str(target) if target is not None else None,
        reason,
    )
    channel_id = await db.get_setting(guild.id, "log_channel")
    if not channel_id:
        return
    channel = guild.get_channel(int(channel_id))
    if channel is None:
        return
    embed = discord.Embed(
        title=action.replace("_", " ").title(),
        color=ACTION_COLORS.get(action, 0x5865F2),
        timestamp=discord.utils.utcnow(),
    )
    embed.add_field(name="Actor", value=str(actor))
    if target is not None:
        embed.add_field(name="Target", value=str(target))
    if reason:
        embed.add_field(name="Reason", value=reason, inline=False)
    try:
        await channel.send(embed=embed)
    except discord.HTTPException:
        pass


def format_template(template: str, member: discord.Member) -> str:
    """Fill {user}, {server}, {membercount} placeholders in welcome/goodbye templates."""
    return (
        template.replace("{user}", member.mention)
        .replace("{server}", member.guild.name)
        .replace("{membercount}", str(member.guild.member_count))
    )
