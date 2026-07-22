"""REST API used by the dashboard.

All Discord snowflake IDs are serialized as strings — they exceed
JavaScript's safe integer range.
"""
from datetime import timedelta

import discord
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel

import db
from bot.utils import log_action
from web.auth import check_password, create_token, require_auth, TOKEN_TTL

router = APIRouter()
protected = APIRouter(dependencies=[Depends(require_auth)])

DASHBOARD_ACTOR = "Dashboard"


# -- helpers ----------------------------------------------------------------

def get_bot(request: Request):
    return request.app.state.bot

def get_guild(request: Request, guild_id: str) -> discord.Guild:
    bot = get_bot(request)
    try:
        guild = bot.get_guild(int(guild_id))
    except ValueError:
        guild = None
    if guild is None:
        raise HTTPException(status_code=404, detail="Guild not found")
    return guild

def get_member(guild: discord.Guild, user_id: str) -> discord.Member:
    try:
        member = guild.get_member(int(user_id))
    except ValueError:
        member = None
    if member is None:
        raise HTTPException(status_code=404, detail="Member not found")
    return member

def serialize_member(m: discord.Member) -> dict:
    return {
        "id": str(m.id),
        "name": m.name,
        "display_name": m.display_name,
        "avatar": m.display_avatar.url,
        "bot": m.bot,
        "joined_at": int(m.joined_at.timestamp()) if m.joined_at else None,
        "roles": [str(r.id) for r in m.roles if not r.is_default()],
        "timed_out": m.is_timed_out(),
    }

def serialize_channel(c) -> dict:
    return {
        "id": str(c.id),
        "name": c.name,
        "type": str(c.type),
        "position": c.position,
        "category": c.category.name if getattr(c, "category", None) else None,
    }

def serialize_role(r: discord.Role) -> dict:
    return {
        "id": str(r.id),
        "name": r.name,
        "color": f"#{r.colour.value:06x}" if r.colour.value else None,
        "position": r.position,
        "members": len(r.members),
        "managed": r.managed,
    }


# -- auth -------------------------------------------------------------------

class LoginBody(BaseModel):
    password: str


@router.post("/login")
async def login(body: LoginBody, response: Response):
    if not check_password(body.password):
        raise HTTPException(status_code=401, detail="Wrong password")
    response.set_cookie(
        "session", create_token(),
        max_age=TOKEN_TTL, httponly=True, samesite="lax", secure=True,
    )
    return {"ok": True}


@router.post("/logout")
async def logout(response: Response):
    response.delete_cookie("session")
    return {"ok": True}


# -- bot-level --------------------------------------------------------------

@protected.get("/me")
async def me(request: Request):
    bot = get_bot(request)
    if not bot.is_ready():
        return {"ready": False}
    return {
        "ready": True,
        "id": str(bot.user.id),
        "name": bot.user.name,
        "avatar": bot.user.display_avatar.url,
        "guild_count": len(bot.guilds),
        "latency_ms": round(bot.latency * 1000),
        "presence": {
            "status": await db.get_setting(0, "presence_status"),
            "activity_type": await db.get_setting(0, "presence_activity_type"),
            "text": await db.get_setting(0, "presence_text"),
        },
    }


class PresenceBody(BaseModel):
    status: str = "online"
    activity_type: str = "playing"
    text: str = ""


@protected.post("/presence")
async def set_presence(body: PresenceBody, request: Request):
    await db.set_setting(0, "presence_status", body.status)
    await db.set_setting(0, "presence_activity_type", body.activity_type)
    await db.set_setting(0, "presence_text", body.text)
    await get_bot(request).apply_presence()
    return {"ok": True}


@protected.get("/guilds")
async def guilds(request: Request):
    return [
        {
            "id": str(g.id),
            "name": g.name,
            "icon": g.icon.url if g.icon else None,
            "member_count": g.member_count,
        }
        for g in get_bot(request).guilds
    ]


# -- guild overview ---------------------------------------------------------

@protected.get("/guilds/{guild_id}")
async def guild_overview(guild_id: str, request: Request):
    g = get_guild(request, guild_id)
    bots = sum(1 for m in g.members if m.bot)
    return {
        "id": str(g.id),
        "name": g.name,
        "icon": g.icon.url if g.icon else None,
        "owner": str(g.owner) if g.owner else None,
        "member_count": g.member_count,
        "humans": (g.member_count or 0) - bots,
        "bots": bots,
        "channels": len(g.channels),
        "roles": len(g.roles),
        "boost_level": g.premium_tier,
        "created_at": int(g.created_at.timestamp()),
    }


# -- settings ---------------------------------------------------------------

@protected.get("/guilds/{guild_id}/settings")
async def get_settings(guild_id: str, request: Request):
    g = get_guild(request, guild_id)
    return await db.get_all_settings(g.id)


@protected.put("/guilds/{guild_id}/settings")
async def put_settings(guild_id: str, body: dict, request: Request):
    g = get_guild(request, guild_id)
    for key, value in body.items():
        if key not in db.DEFAULTS:
            raise HTTPException(status_code=400, detail=f"Unknown setting: {key}")
        await db.set_setting(g.id, key, value)
    return {"ok": True}


# -- members ----------------------------------------------------------------

@protected.get("/guilds/{guild_id}/members")
async def members(guild_id: str, request: Request, search: str = "", offset: int = 0, limit: int = 50):
    g = get_guild(request, guild_id)
    result = sorted(g.members, key=lambda m: m.display_name.lower())
    if search:
        s = search.lower()
        result = [m for m in result
                  if s in m.name.lower() or s in m.display_name.lower() or s == str(m.id)]
    limit = max(1, min(limit, 100))
    return {
        "total": len(result),
        "members": [serialize_member(m) for m in result[offset:offset + limit]],
    }


class MemberActionBody(BaseModel):
    action: str  # kick | ban | unban | timeout | untimeout | warn
    reason: str | None = None
    minutes: int | None = None


@protected.post("/guilds/{guild_id}/members/{user_id}/action")
async def member_action(guild_id: str, user_id: str, body: MemberActionBody, request: Request):
    g = get_guild(request, guild_id)
    reason = body.reason

    if body.action == "unban":
        await g.unban(discord.Object(id=int(user_id)), reason=reason)
        await log_action(g, "unban", DASHBOARD_ACTOR, user_id, reason)
        return {"ok": True}
    if body.action == "ban":
        # allow banning users who are no longer members
        await g.ban(discord.Object(id=int(user_id)), reason=reason)
        await log_action(g, "ban", DASHBOARD_ACTOR, user_id, reason)
        return {"ok": True}

    member = get_member(g, user_id)
    if body.action == "kick":
        await member.kick(reason=reason)
        await log_action(g, "kick", DASHBOARD_ACTOR, member, reason)
    elif body.action == "timeout":
        minutes = max(1, min(body.minutes or 10, 40320))
        await member.timeout(timedelta(minutes=minutes), reason=reason)
        await log_action(g, "timeout", DASHBOARD_ACTOR, member, f"{reason or 'No reason'} ({minutes}m)")
    elif body.action == "untimeout":
        await member.timeout(None)
        await log_action(g, "untimeout", DASHBOARD_ACTOR, member, None)
    elif body.action == "warn":
        await db.add_warning(g.id, member.id, 0, reason)
        await log_action(g, "warn", DASHBOARD_ACTOR, member, reason)
    else:
        raise HTTPException(status_code=400, detail="Unknown action")
    return {"ok": True}


class RolesUpdateBody(BaseModel):
    add: list[str] = []
    remove: list[str] = []


@protected.post("/guilds/{guild_id}/members/{user_id}/roles")
async def member_roles(guild_id: str, user_id: str, body: RolesUpdateBody, request: Request):
    g = get_guild(request, guild_id)
    member = get_member(g, user_id)
    if body.add:
        await member.add_roles(*[discord.Object(id=int(r)) for r in body.add])
    if body.remove:
        await member.remove_roles(*[discord.Object(id=int(r)) for r in body.remove])
    await log_action(g, "role_update", DASHBOARD_ACTOR, member,
                     f"+{len(body.add)} -{len(body.remove)}")
    return {"ok": True}


# -- channels ---------------------------------------------------------------

@protected.get("/guilds/{guild_id}/channels")
async def channels(guild_id: str, request: Request):
    g = get_guild(request, guild_id)
    ordered = sorted(g.channels, key=lambda c: (c.category.position if c.category else -1, c.position))
    return [serialize_channel(c) for c in ordered]


class ChannelCreateBody(BaseModel):
    name: str
    type: str = "text"  # text | voice | category


@protected.post("/guilds/{guild_id}/channels")
async def create_channel(guild_id: str, body: ChannelCreateBody, request: Request):
    g = get_guild(request, guild_id)
    if body.type == "voice":
        channel = await g.create_voice_channel(body.name)
    elif body.type == "category":
        channel = await g.create_category(body.name)
    else:
        channel = await g.create_text_channel(body.name)
    await log_action(g, "channel_create", DASHBOARD_ACTOR, channel.name, body.type)
    return serialize_channel(channel)


@protected.delete("/guilds/{guild_id}/channels/{channel_id}")
async def delete_channel(guild_id: str, channel_id: str, request: Request):
    g = get_guild(request, guild_id)
    channel = g.get_channel(int(channel_id))
    if channel is None:
        raise HTTPException(status_code=404, detail="Channel not found")
    name = channel.name
    await channel.delete()
    await log_action(g, "channel_delete", DASHBOARD_ACTOR, name, None)
    return {"ok": True}


class MessageBody(BaseModel):
    content: str


@protected.post("/guilds/{guild_id}/channels/{channel_id}/messages")
async def send_message(guild_id: str, channel_id: str, body: MessageBody, request: Request):
    g = get_guild(request, guild_id)
    channel = g.get_channel(int(channel_id))
    if channel is None or not isinstance(channel, discord.TextChannel):
        raise HTTPException(status_code=404, detail="Text channel not found")
    if not body.content.strip():
        raise HTTPException(status_code=400, detail="Message is empty")
    message = await channel.send(body.content[:2000])
    return {"ok": True, "message_id": str(message.id)}


# -- roles ------------------------------------------------------------------

@protected.get("/guilds/{guild_id}/roles")
async def roles(guild_id: str, request: Request):
    g = get_guild(request, guild_id)
    ordered = sorted(g.roles, key=lambda r: -r.position)
    return [serialize_role(r) for r in ordered if not r.is_default()]


class RoleCreateBody(BaseModel):
    name: str
    color: str | None = None


@protected.post("/guilds/{guild_id}/roles")
async def create_role(guild_id: str, body: RoleCreateBody, request: Request):
    g = get_guild(request, guild_id)
    colour = discord.Colour.default()
    if body.color:
        try:
            colour = discord.Colour(int(body.color.lstrip("#"), 16))
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid hex color")
    role = await g.create_role(name=body.name, colour=colour)
    await log_action(g, "role_create", DASHBOARD_ACTOR, role.name, None)
    return serialize_role(role)


@protected.delete("/guilds/{guild_id}/roles/{role_id}")
async def delete_role(guild_id: str, role_id: str, request: Request):
    g = get_guild(request, guild_id)
    role = g.get_role(int(role_id))
    if role is None:
        raise HTTPException(status_code=404, detail="Role not found")
    name = role.name
    await role.delete()
    await log_action(g, "role_delete", DASHBOARD_ACTOR, name, None)
    return {"ok": True}


# -- warnings & logs --------------------------------------------------------

@protected.get("/guilds/{guild_id}/warnings")
async def warnings(guild_id: str, request: Request, user_id: str | None = None):
    g = get_guild(request, guild_id)
    bot = get_bot(request)
    rows = await db.get_warnings(g.id, int(user_id) if user_id else None)
    for row in rows:
        member = g.get_member(row["user_id"])
        row["user_name"] = str(member) if member else str(row["user_id"])
        mod = g.get_member(row["moderator_id"]) or bot.get_user(row["moderator_id"])
        row["moderator_name"] = str(mod) if mod else (DASHBOARD_ACTOR if row["moderator_id"] == 0 else str(row["moderator_id"]))
        row["user_id"] = str(row["user_id"])
        row["moderator_id"] = str(row["moderator_id"])
    return rows


@protected.delete("/guilds/{guild_id}/warnings/{warning_id}")
async def delete_warning(guild_id: str, warning_id: int, request: Request):
    g = get_guild(request, guild_id)
    if not await db.delete_warning(g.id, warning_id):
        raise HTTPException(status_code=404, detail="Warning not found")
    return {"ok": True}


@protected.get("/guilds/{guild_id}/logs")
async def logs(guild_id: str, request: Request, limit: int = 100):
    g = get_guild(request, guild_id)
    return await db.get_logs(g.id, max(1, min(limit, 500)))


router.include_router(protected)
