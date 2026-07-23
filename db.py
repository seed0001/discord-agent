"""Async SQLite storage for guild settings, warnings, and moderation logs.

Settings are stored per guild as JSON-encoded key/value pairs. Global bot
settings (e.g. presence) use guild_id 0.
"""
import json
import os
import time

import aiosqlite

import config

_db: aiosqlite.Connection | None = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id INTEGER NOT NULL,
    key      TEXT NOT NULL,
    value    TEXT NOT NULL,
    PRIMARY KEY (guild_id, key)
);
CREATE TABLE IF NOT EXISTS warnings (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id     INTEGER NOT NULL,
    user_id      INTEGER NOT NULL,
    moderator_id INTEGER NOT NULL,
    reason       TEXT,
    created_at   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mod_logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id   INTEGER NOT NULL,
    action     TEXT NOT NULL,
    actor      TEXT NOT NULL,
    target     TEXT,
    reason     TEXT,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_warnings_guild_user ON warnings (guild_id, user_id);
CREATE INDEX IF NOT EXISTS idx_logs_guild ON mod_logs (guild_id, created_at);
"""

DEFAULTS = {
    # logging
    "log_channel": None,
    # welcome / goodbye
    "welcome_channel": None,
    "welcome_message": "Welcome {user} to {server}! You are member #{membercount}.",
    "goodbye_message": "{user} has left {server}.",
    "autorole": None,
    # automod
    "automod_enabled": False,
    "banned_words": [],
    "block_invites": False,
    "max_mentions": 0,
    # AI
    "ai_enabled": True,
    "ai_model": config.OPENROUTER_MODEL,
    "ai_system_prompt": (
        "You're a chill, laid-back vibe coder — equal parts stoner philosopher and "
        "10x hacker. You keep it mellow: lowercase energy, dry humor, the occasional "
        "'dude' or 'no worries', never corporate. You genuinely love clean code, good "
        "music, and good vibes, and you get quietly stoked when someone ships something "
        "cool. Stay helpful and correct underneath the chill — short replies, no "
        "walls of text, no lectures."
    ),
    "ai_channels": [],
    # voice monitoring (audio capture via the Node.js sidecar in listener/)
    "voice_enabled": True,
    "voice_wake_words": ["hey max", "hey andrew"],
    # global presence (guild_id 0)
    "presence_status": "online",
    "presence_activity_type": "playing",
    "presence_text": "",
}


async def init_db() -> None:
    global _db
    directory = os.path.dirname(config.DATABASE_PATH)
    if directory:
        os.makedirs(directory, exist_ok=True)
    _db = await aiosqlite.connect(config.DATABASE_PATH)
    _db.row_factory = aiosqlite.Row
    await _db.executescript(SCHEMA)
    await _db.commit()


async def close_db() -> None:
    global _db
    if _db is not None:
        await _db.close()
        _db = None


# -- settings ---------------------------------------------------------------

async def get_setting(guild_id: int, key: str):
    cur = await _db.execute(
        "SELECT value FROM guild_settings WHERE guild_id = ? AND key = ?", (guild_id, key)
    )
    row = await cur.fetchone()
    if row is None:
        return DEFAULTS.get(key)
    return json.loads(row["value"])


async def get_all_settings(guild_id: int) -> dict:
    settings = dict(DEFAULTS)
    cur = await _db.execute(
        "SELECT key, value FROM guild_settings WHERE guild_id = ?", (guild_id,)
    )
    for row in await cur.fetchall():
        settings[row["key"]] = json.loads(row["value"])
    return settings


async def set_setting(guild_id: int, key: str, value) -> None:
    await _db.execute(
        "INSERT INTO guild_settings (guild_id, key, value) VALUES (?, ?, ?) "
        "ON CONFLICT (guild_id, key) DO UPDATE SET value = excluded.value",
        (guild_id, key, json.dumps(value)),
    )
    await _db.commit()


# -- warnings ---------------------------------------------------------------

async def add_warning(guild_id: int, user_id: int, moderator_id: int, reason: str | None) -> int:
    cur = await _db.execute(
        "INSERT INTO warnings (guild_id, user_id, moderator_id, reason, created_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (guild_id, user_id, moderator_id, reason, int(time.time())),
    )
    await _db.commit()
    return cur.lastrowid


async def get_warnings(guild_id: int, user_id: int | None = None, limit: int = 100) -> list[dict]:
    if user_id is None:
        cur = await _db.execute(
            "SELECT * FROM warnings WHERE guild_id = ? ORDER BY created_at DESC LIMIT ?",
            (guild_id, limit),
        )
    else:
        cur = await _db.execute(
            "SELECT * FROM warnings WHERE guild_id = ? AND user_id = ? "
            "ORDER BY created_at DESC LIMIT ?",
            (guild_id, user_id, limit),
        )
    return [dict(row) for row in await cur.fetchall()]


async def delete_warning(guild_id: int, warning_id: int) -> bool:
    cur = await _db.execute(
        "DELETE FROM warnings WHERE guild_id = ? AND id = ?", (guild_id, warning_id)
    )
    await _db.commit()
    return cur.rowcount > 0


async def clear_warnings(guild_id: int, user_id: int) -> int:
    cur = await _db.execute(
        "DELETE FROM warnings WHERE guild_id = ? AND user_id = ?", (guild_id, user_id)
    )
    await _db.commit()
    return cur.rowcount


# -- moderation logs --------------------------------------------------------

async def add_log(guild_id: int, action: str, actor: str, target: str | None, reason: str | None) -> None:
    await _db.execute(
        "INSERT INTO mod_logs (guild_id, action, actor, target, reason, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (guild_id, action, actor, target, reason, int(time.time())),
    )
    await _db.commit()


async def get_logs(guild_id: int, limit: int = 100) -> list[dict]:
    cur = await _db.execute(
        "SELECT * FROM mod_logs WHERE guild_id = ? ORDER BY created_at DESC LIMIT ?",
        (guild_id, limit),
    )
    return [dict(row) for row in await cur.fetchall()]
