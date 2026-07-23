"""Tools the AI agent can call to manage the server directly.

Each tool pairs an OpenAI-style function schema (sent to the model) with an
async handler that performs the real Discord action. Handlers return a short
string that is fed back to the model as the tool result.

All tools are owner-only: ai.py only offers them when the triggering message
author is the bot owner, and execute() re-checks before running anything.
"""
import json
from datetime import timedelta

import discord

import db
from bot.utils import is_owner, log_action


class ToolError(Exception):
    """Raised by handlers; the message is returned to the model as the result."""


def _str(desc: str) -> dict:
    return {"type": "string", "description": desc}


def _int(desc: str) -> dict:
    return {"type": "integer", "description": desc}


def _schema(name: str, description: str, params: dict | None = None,
            required: list[str] | None = None) -> dict:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": params or {},
                "required": required or [],
            },
        },
    }


# -- resolution helpers -----------------------------------------------------

async def _resolve_member(guild: discord.Guild, ref) -> discord.Member:
    ref = str(ref).strip()
    digits = ref.strip("<@!>")
    if digits.isdigit():
        member = guild.get_member(int(digits))
        if member is None:
            try:
                member = await guild.fetch_member(int(digits))
            except discord.HTTPException:
                member = None
        if member is not None:
            return member
    low = ref.lower()
    for m in guild.members:
        if low in (m.name.lower(), m.display_name.lower(), str(m).lower()):
            return m
    raise ToolError(f"No member found matching '{ref}'. Try search_members to find them.")


def _resolve_role(guild: discord.Guild, ref) -> discord.Role:
    ref = str(ref).strip()
    digits = ref.strip("<@&>")
    if digits.isdigit():
        role = guild.get_role(int(digits))
        if role is not None:
            return role
    low = ref.lower()
    for r in guild.roles:
        if r.name.lower() == low:
            return r
    raise ToolError(f"No role found matching '{ref}'. Use list_roles to see them.")


def _resolve_channel(guild: discord.Guild, ref) -> discord.abc.GuildChannel:
    ref = str(ref).strip()
    digits = ref.strip("<#>")
    if digits.isdigit():
        channel = guild.get_channel(int(digits))
        if channel is not None:
            return channel
    low = ref.lstrip("#").lower()
    for c in guild.channels:
        if c.name.lower() == low:
            return c
    raise ToolError(f"No channel found matching '{ref}'. Use list_channels to see them.")


def _text_channel(message: discord.Message, args: dict) -> discord.TextChannel:
    """The channel named in args, or the channel the request came from."""
    ref = args.get("channel")
    if not ref:
        return message.channel
    channel = _resolve_channel(message.guild, ref)
    if not isinstance(channel, discord.TextChannel):
        raise ToolError(f"#{channel.name} is not a text channel.")
    return channel


def _check_target(message: discord.Message, member: discord.Member) -> None:
    if member.id == message.guild.me.id:
        raise ToolError("I won't take moderation actions against myself.")
    if is_owner(member.id):
        raise ToolError("I won't take moderation actions against the bot owner.")


def _actor(message: discord.Message) -> str:
    return f"AI (for {message.author})"


# -- info tools -------------------------------------------------------------

async def _server_info(bot, message, args):
    g = message.guild
    return (f"Server: {g.name} (id {g.id}) | Owner: {g.owner} | Members: {g.member_count} | "
            f"Channels: {len(g.channels)} | Roles: {len(g.roles)} | Boost tier: {g.premium_tier}")


async def _list_channels(bot, message, args):
    lines = []
    for c in message.guild.channels:
        kind = type(c).__name__.replace("Channel", "").lower() or "channel"
        lines.append(f"#{c.name} (id {c.id}, {kind})")
    return "\n".join(lines) or "No channels."


async def _list_roles(bot, message, args):
    lines = [f"{r.name} (id {r.id}, {len(r.members)} members)"
             for r in reversed(message.guild.roles) if not r.is_default()]
    return "\n".join(lines) or "No roles."


async def _member_info(bot, message, args):
    m = await _resolve_member(message.guild, args["user"])
    roles = ", ".join(r.name for r in m.roles if not r.is_default()) or "none"
    joined = f"<t:{int(m.joined_at.timestamp())}:D>" if m.joined_at else "?"
    timed_out = "yes" if m.is_timed_out() else "no"
    return (f"{m} (id {m.id}) | Display name: {m.display_name} | Joined: {joined} | "
            f"Roles: {roles} | Timed out: {timed_out} | Bot: {'yes' if m.bot else 'no'}")


async def _search_members(bot, message, args):
    query = args["query"].lower()
    limit = min(int(args.get("limit", 10)), 25)
    matches = [m for m in message.guild.members
               if query in m.name.lower() or query in m.display_name.lower()]
    if not matches:
        return f"No members matching '{args['query']}'."
    return "\n".join(f"{m} (id {m.id}, display name: {m.display_name})" for m in matches[:limit])


async def _get_mod_logs(bot, message, args):
    limit = min(int(args.get("limit", 15)), 50)
    rows = await db.get_logs(message.guild.id, limit)
    if not rows:
        return "No moderation logs yet."
    return "\n".join(
        f"[{r['action']}] actor: {r['actor']}, target: {r['target'] or '-'}, "
        f"reason: {r['reason'] or '-'}" for r in rows)


# -- moderation tools -------------------------------------------------------

async def _kick_member(bot, message, args):
    m = await _resolve_member(message.guild, args["user"])
    _check_target(message, m)
    reason = args.get("reason")
    await m.kick(reason=reason)
    await log_action(message.guild, "kick", _actor(message), m, reason)
    return f"Kicked {m}."


async def _ban_member(bot, message, args):
    m = await _resolve_member(message.guild, args["user"])
    _check_target(message, m)
    reason = args.get("reason")
    delete_days = max(0, min(int(args.get("delete_days", 0)), 7))
    await m.ban(reason=reason, delete_message_seconds=delete_days * 86400)
    await log_action(message.guild, "ban", _actor(message), m, reason)
    return f"Banned {m}."


async def _unban_user(bot, message, args):
    user_id = str(args["user_id"]).strip("<@!>")
    if not user_id.isdigit():
        raise ToolError("user_id must be a numeric Discord user ID.")
    reason = args.get("reason")
    await message.guild.unban(discord.Object(id=int(user_id)), reason=reason)
    await log_action(message.guild, "unban", _actor(message), user_id, reason)
    return f"Unbanned user {user_id}."


async def _timeout_member(bot, message, args):
    m = await _resolve_member(message.guild, args["user"])
    _check_target(message, m)
    minutes = max(1, min(int(args["minutes"]), 40320))
    reason = args.get("reason")
    await m.timeout(timedelta(minutes=minutes), reason=reason)
    await log_action(message.guild, "timeout", _actor(message), m,
                     f"{reason or 'No reason'} ({minutes}m)")
    return f"Timed out {m} for {minutes} minute(s)."


async def _untimeout_member(bot, message, args):
    m = await _resolve_member(message.guild, args["user"])
    await m.timeout(None)
    await log_action(message.guild, "untimeout", _actor(message), m, None)
    return f"Removed timeout for {m}."


async def _warn_member(bot, message, args):
    m = await _resolve_member(message.guild, args["user"])
    _check_target(message, m)
    reason = args["reason"]
    await db.add_warning(message.guild.id, m.id, message.author.id, reason)
    await log_action(message.guild, "warn", _actor(message), m, reason)
    count = len(await db.get_warnings(message.guild.id, m.id))
    try:
        await m.send(f"You were warned in **{message.guild.name}**: {reason}")
    except discord.HTTPException:
        pass
    return f"Warned {m} (warning #{count})."


async def _list_warnings(bot, message, args):
    m = await _resolve_member(message.guild, args["user"])
    rows = await db.get_warnings(message.guild.id, m.id)
    if not rows:
        return f"{m} has no warnings."
    return f"{m} has {len(rows)} warning(s):\n" + "\n".join(
        f"#{r['id']}: {r['reason'] or 'No reason'}" for r in rows[:15])


async def _clear_warnings(bot, message, args):
    m = await _resolve_member(message.guild, args["user"])
    count = await db.clear_warnings(message.guild.id, m.id)
    await log_action(message.guild, "clear_warnings", _actor(message), m, f"{count} removed")
    return f"Cleared {count} warning(s) for {m}."


async def _purge_messages(bot, message, args):
    channel = _text_channel(message, args)
    amount = max(1, min(int(args["amount"]), 100))
    deleted = await channel.purge(limit=amount)
    await log_action(message.guild, "purge", _actor(message),
                     f"#{channel.name}", f"{len(deleted)} messages")
    return f"Deleted {len(deleted)} message(s) in #{channel.name}."


async def _set_slowmode(bot, message, args):
    channel = _text_channel(message, args)
    seconds = max(0, min(int(args["seconds"]), 21600))
    await channel.edit(slowmode_delay=seconds)
    return (f"Slowmode set to {seconds}s in #{channel.name}." if seconds
            else f"Slowmode disabled in #{channel.name}.")


async def _lock_channel(bot, message, args):
    channel = _text_channel(message, args)
    locked = bool(args.get("locked", True))
    await channel.set_permissions(message.guild.default_role,
                                  send_messages=False if locked else None)
    action = "lock" if locked else "unlock"
    await log_action(message.guild, action, _actor(message), f"#{channel.name}", None)
    return f"{'Locked' if locked else 'Unlocked'} #{channel.name}."


# -- channel tools ----------------------------------------------------------

async def _create_channel(bot, message, args):
    guild = message.guild
    name = args["name"]
    kind = args.get("kind", "text")
    category = None
    if args.get("category"):
        target = _resolve_channel(guild, args["category"])
        if not isinstance(target, discord.CategoryChannel):
            raise ToolError(f"'{target.name}' is not a category.")
        category = target
    if kind == "voice":
        channel = await guild.create_voice_channel(name, category=category)
    elif kind == "category":
        channel = await guild.create_category(name)
    elif kind == "forum":
        channel = await guild.create_forum(name, category=category)
    else:
        kind = "text"
        channel = await guild.create_text_channel(name, category=category)
    await log_action(guild, "channel_create", _actor(message), channel.name, kind)
    return f"Created {kind} channel #{channel.name} (id {channel.id})."


async def _delete_channel(bot, message, args):
    channel = _resolve_channel(message.guild, args["channel"])
    name = channel.name
    await channel.delete()
    await log_action(message.guild, "channel_delete", _actor(message), name, None)
    return f"Deleted channel #{name}."


async def _set_channel_topic(bot, message, args):
    channel = _text_channel(message, args)
    await channel.edit(topic=args["topic"])
    return f"Updated topic for #{channel.name}."


async def _send_message(bot, message, args):
    channel = _text_channel(message, args)
    content = args["content"][:2000]
    await channel.send(content)
    return f"Sent the message to #{channel.name}."


# -- role tools -------------------------------------------------------------

async def _give_role(bot, message, args):
    m = await _resolve_member(message.guild, args["user"])
    role = _resolve_role(message.guild, args["role"])
    await m.add_roles(role)
    await log_action(message.guild, "role_add", _actor(message), m, role.name)
    return f"Gave {role.name} to {m}."


async def _take_role(bot, message, args):
    m = await _resolve_member(message.guild, args["user"])
    role = _resolve_role(message.guild, args["role"])
    await m.remove_roles(role)
    await log_action(message.guild, "role_remove", _actor(message), m, role.name)
    return f"Removed {role.name} from {m}."


async def _create_role(bot, message, args):
    colour = discord.Colour.default()
    if args.get("color"):
        try:
            colour = discord.Colour(int(str(args["color"]).lstrip("#"), 16))
        except ValueError:
            raise ToolError("Invalid hex color; use e.g. #5865F2.")
    role = await message.guild.create_role(name=args["name"], colour=colour)
    await log_action(message.guild, "role_create", _actor(message), role.name, None)
    return f"Created role {role.name} (id {role.id})."


async def _delete_role(bot, message, args):
    role = _resolve_role(message.guild, args["role"])
    name = role.name
    await role.delete()
    await log_action(message.guild, "role_delete", _actor(message), name, None)
    return f"Deleted role {name}."


# -- registry ---------------------------------------------------------------

_USER = _str("The member: a mention, user ID, username, or display name")
_CHANNEL_OPT = _str("Channel name, mention, or ID (defaults to the current channel)")

TOOLS: dict[str, tuple[dict, callable]] = {
    "server_info": (_schema(
        "server_info", "Get a summary of this server (name, owner, member/channel/role counts)."),
        _server_info),
    "list_channels": (_schema(
        "list_channels", "List every channel in the server with its ID and type."),
        _list_channels),
    "list_roles": (_schema(
        "list_roles", "List every role in the server with its ID and member count."),
        _list_roles),
    "member_info": (_schema(
        "member_info", "Get details about one member (roles, join date, timeout status).",
        {"user": _USER}, ["user"]), _member_info),
    "search_members": (_schema(
        "search_members", "Search members by name or display name.",
        {"query": _str("Text to match against usernames and display names"),
         "limit": _int("Max results (default 10, max 25)")}, ["query"]), _search_members),
    "get_mod_logs": (_schema(
        "get_mod_logs", "Show recent moderation log entries for this server.",
        {"limit": _int("How many entries (default 15, max 50)")}), _get_mod_logs),
    "kick_member": (_schema(
        "kick_member", "Kick a member from the server.",
        {"user": _USER, "reason": _str("Reason for the kick")}, ["user"]), _kick_member),
    "ban_member": (_schema(
        "ban_member", "Ban a member from the server.",
        {"user": _USER, "reason": _str("Reason for the ban"),
         "delete_days": _int("Days of their messages to delete (0-7, default 0)")},
        ["user"]), _ban_member),
    "unban_user": (_schema(
        "unban_user", "Unban a user by their numeric Discord ID.",
        {"user_id": _str("Numeric Discord user ID"),
         "reason": _str("Reason for the unban")}, ["user_id"]), _unban_user),
    "timeout_member": (_schema(
        "timeout_member", "Timeout (mute) a member for a number of minutes.",
        {"user": _USER, "minutes": _int("Duration in minutes (1-40320)"),
         "reason": _str("Reason for the timeout")}, ["user", "minutes"]), _timeout_member),
    "untimeout_member": (_schema(
        "untimeout_member", "Remove a member's timeout.",
        {"user": _USER}, ["user"]), _untimeout_member),
    "warn_member": (_schema(
        "warn_member", "Warn a member (recorded, and DMed to them).",
        {"user": _USER, "reason": _str("Reason for the warning")},
        ["user", "reason"]), _warn_member),
    "list_warnings": (_schema(
        "list_warnings", "List a member's warnings.",
        {"user": _USER}, ["user"]), _list_warnings),
    "clear_warnings": (_schema(
        "clear_warnings", "Clear all warnings for a member.",
        {"user": _USER}, ["user"]), _clear_warnings),
    "purge_messages": (_schema(
        "purge_messages", "Delete recent messages in a channel.",
        {"amount": _int("Number of messages to delete (1-100)"),
         "channel": _CHANNEL_OPT}, ["amount"]), _purge_messages),
    "set_slowmode": (_schema(
        "set_slowmode", "Set slowmode delay for a text channel (0 disables).",
        {"seconds": _int("Seconds between messages (0-21600)"),
         "channel": _CHANNEL_OPT}, ["seconds"]), _set_slowmode),
    "lock_channel": (_schema(
        "lock_channel", "Lock or unlock a text channel for @everyone.",
        {"locked": {"type": "boolean", "description": "true to lock, false to unlock (default true)"},
         "channel": _CHANNEL_OPT}), _lock_channel),
    "create_channel": (_schema(
        "create_channel", "Create a text, voice, category, or forum channel.",
        {"name": _str("Name for the new channel"),
         "kind": {"type": "string", "enum": ["text", "voice", "category", "forum"],
                  "description": "Channel type (default text)"},
         "category": _str("Category to place the channel in (optional)")}, ["name"]),
        _create_channel),
    "delete_channel": (_schema(
        "delete_channel", "Delete a channel.",
        {"channel": _str("Channel name, mention, or ID")}, ["channel"]), _delete_channel),
    "set_channel_topic": (_schema(
        "set_channel_topic", "Set the topic of a text channel.",
        {"topic": _str("New channel topic"), "channel": _CHANNEL_OPT}, ["topic"]),
        _set_channel_topic),
    "send_message": (_schema(
        "send_message", "Send a message as the bot to a channel.",
        {"content": _str("The message to send"), "channel": _CHANNEL_OPT}, ["content"]),
        _send_message),
    "give_role": (_schema(
        "give_role", "Give a role to a member.",
        {"user": _USER, "role": _str("Role name, mention, or ID")},
        ["user", "role"]), _give_role),
    "take_role": (_schema(
        "take_role", "Remove a role from a member.",
        {"user": _USER, "role": _str("Role name, mention, or ID")},
        ["user", "role"]), _take_role),
    "create_role": (_schema(
        "create_role", "Create a new role.",
        {"name": _str("Name for the new role"),
         "color": _str("Hex color, e.g. #5865F2 (optional)")}, ["name"]), _create_role),
    "delete_role": (_schema(
        "delete_role", "Delete a role.",
        {"role": _str("Role name, mention, or ID")}, ["role"]), _delete_role),
}

TOOL_SCHEMAS = [entry[0] for entry in TOOLS.values()]


async def execute(bot, message: discord.Message, name: str, arguments) -> str:
    """Run one tool call and return its result string (never raises)."""
    if not is_owner(message.author.id):
        return "Error: only the bot owner can use management tools."
    entry = TOOLS.get(name)
    if entry is None:
        return f"Error: unknown tool '{name}'."
    try:
        args = json.loads(arguments) if isinstance(arguments, str) else (arguments or {})
        if not isinstance(args, dict):
            raise ToolError("Tool arguments must be an object.")
    except json.JSONDecodeError:
        return "Error: tool arguments were not valid JSON."
    try:
        return await entry[1](bot, message, args)
    except ToolError as exc:
        return f"Error: {exc}"
    except (KeyError, TypeError, ValueError) as exc:
        return f"Error: bad or missing tool arguments ({exc})."
    except discord.Forbidden:
        return "Error: I don't have permission to do that. Check my role position and permissions."
    except discord.HTTPException as exc:
        return f"Error: Discord API error: {exc}"
