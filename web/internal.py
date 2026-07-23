"""Internal API for the Node.js voice listener sidecar (listener/).

Localhost-only in practice; authenticated with the shared SECRET_KEY via the
x-internal-key header. The sidecar posts decrypted per-user voice audio here
and asks for per-guild voice config; content decisions happen in the Voice
cog (bot/cogs/voice.py).
"""
from fastapi import APIRouter, HTTPException, Request

import config

router = APIRouter()


def _auth(request: Request) -> None:
    if not config.SECRET_KEY or request.headers.get("x-internal-key") != config.SECRET_KEY:
        raise HTTPException(status_code=401, detail="bad internal key")


def _voice_cog(request: Request):
    cog = request.app.state.bot.get_cog("Voice")
    if cog is None:
        raise HTTPException(status_code=503, detail="voice cog not loaded")
    return cog


def _int_header(request: Request, name: str) -> int:
    try:
        return int(request.headers[name])
    except (KeyError, ValueError):
        raise HTTPException(status_code=400, detail=f"missing/invalid {name} header")


@router.get("/voice-config")
async def voice_config(guild_id: str, request: Request):
    _auth(request)
    try:
        gid = int(guild_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid guild_id")
    return await _voice_cog(request).voice_config(gid)


@router.post("/voice-event")
async def voice_event(request: Request):
    _auth(request)
    body = await request.json()
    try:
        guild_id, channel_id = int(body["guild_id"]), int(body["channel_id"])
    except (KeyError, ValueError, TypeError):
        raise HTTPException(status_code=400, detail="invalid guild_id/channel_id")
    await _voice_cog(request).handle_event(guild_id, channel_id, str(body.get("type", "")))
    return {"ok": True}


@router.post("/utterance")
async def utterance(request: Request):
    _auth(request)
    pcm = await request.body()
    result = await _voice_cog(request).handle_utterance(
        _int_header(request, "x-guild-id"),
        _int_header(request, "x-channel-id"),
        _int_header(request, "x-user-id"),
        pcm,
    )
    return result or {}
