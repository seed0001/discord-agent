// SQLite storage — ported from db.py, same schema shape, so a later
// cutover doesn't need a data migration. Uses node:sqlite (built into
// Node 22, no native dependency to install/compile) rather than
// aiosqlite; DatabaseSync is genuinely synchronous, which is the normal,
// correct way to use embedded SQLite in Node (there's no real async I/O
// happening — better-sqlite3, the most popular userland alternative, is
// sync-only for the same reason) — so these functions are NOT async,
// unlike their Python counterparts.
//
// DEFAULTS here is intentionally smaller than db.py's: only settings this
// bot can currently act on (ai_model, ai_system_prompt, voice wake/cancel
// words, quiet_mode). Copying Python's full DEFAULTS — which references
// sandbox/GitHub/moderation tools that don't exist here yet — would mean
// persona text claiming capabilities this bot doesn't actually have, the
// exact bug fixed earlier in the Python bot's voice.py. Grows as real
// features land here, not ahead of them.
//
// guild_id/user_id/etc. are TEXT here, not INTEGER like db.py — Discord
// snowflake IDs routinely exceed Number.MAX_SAFE_INTEGER, and discord.js
// already hands them to callers as strings (interaction.guild.id, etc.).
// Every function coerces with String(...) so callers can pass either.
import { DatabaseSync } from 'node:sqlite';
import {
  VOICE_WAKE_WORDS, VOICE_CANCEL_WORDS, VOICE_STOP_SPEAKING_WORDS,
  VOICE_STOP_LISTENING_WORDS, VOICE_FOLLOWUP_WINDOW_SEC, OPENROUTER_MODEL,
} from './config.js';
import { SYSTEM_PROMPT, CAPABILITY_PROMPT } from './persona.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id TEXT NOT NULL,
    key      TEXT NOT NULL,
    value    TEXT NOT NULL,
    PRIMARY KEY (guild_id, key)
);
CREATE TABLE IF NOT EXISTS warnings (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id     TEXT NOT NULL,
    user_id      TEXT NOT NULL,
    moderator_id TEXT NOT NULL,
    reason       TEXT,
    created_at   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mod_logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id   TEXT NOT NULL,
    action     TEXT NOT NULL,
    actor      TEXT NOT NULL,
    target     TEXT,
    reason     TEXT,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memory (
    guild_id   TEXT NOT NULL,
    kind       TEXT NOT NULL,
    content    TEXT NOT NULL,
    version    INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, kind)
);
CREATE TABLE IF NOT EXISTS memory_versions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id   TEXT NOT NULL,
    kind       TEXT NOT NULL,
    version    INTEGER NOT NULL,
    content    TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS knowledge_base (
    guild_id   TEXT NOT NULL,
    slug       TEXT NOT NULL,
    title      TEXT NOT NULL,
    content    TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, slug)
);
CREATE TABLE IF NOT EXISTS manuscripts (
    guild_id   TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    content    TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id)
);
CREATE TABLE IF NOT EXISTS turns (
    guild_id     TEXT NOT NULL,
    seq          INTEGER NOT NULL,
    speaker      TEXT NOT NULL,
    user_id      TEXT,
    text         TEXT NOT NULL,
    source       TEXT NOT NULL,
    channel      TEXT,
    ts           REAL NOT NULL,
    consolidated INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_warnings_guild_user ON warnings (guild_id, user_id);
CREATE INDEX IF NOT EXISTS idx_logs_guild ON mod_logs (guild_id, created_at);
CREATE INDEX IF NOT EXISTS idx_memver ON memory_versions (guild_id, kind, version);
CREATE INDEX IF NOT EXISTS idx_turns_guild_consolidated ON turns (guild_id, consolidated);
`;

export const MEMORY_VERSIONS_KEPT = 10;

export const DEFAULTS = {
  ai_enabled: true,
  ai_model: OPENROUTER_MODEL,
  // Two halves, edited separately on the dashboard: who he is, and what he
  // can do. A guild that never customises one keeps getting the current text
  // from persona.js, so neither can be lost to a fresh database and the
  // capability half stays true as features land. Saving from the dashboard
  // pins that guild to its own copy.
  ai_system_prompt: SYSTEM_PROMPT,
  ai_capability_prompt: CAPABILITY_PROMPT,
  // Channels where he replies to everything, no @mention needed. The
  // dashboard has always offered this control; without the key here the
  // settings PUT rejected it and the whole Settings tab failed to save.
  ai_channels: [],
  voice_wake_words: VOICE_WAKE_WORDS,
  voice_cancel_words: VOICE_CANCEL_WORDS,
  // Follow-up mode: for this many seconds after Max finishes speaking,
  // anyone in the channel can carry the conversation on without saying the
  // wake word again. Each real answer re-arms it. 0 disables it.
  voice_followup_enabled: true,
  voice_followup_window_sec: VOICE_FOLLOWUP_WINDOW_SEC,
  voice_stop_speaking_words: VOICE_STOP_SPEAKING_WORDS,
  voice_stop_listening_words: VOICE_STOP_LISTENING_WORDS,
  quiet_mode: false,
  log_channel: null,
  // welcome / goodbye / autorole
  welcome_channel: null,
  welcome_message: 'Welcome {user} to {server}! You are member #{membercount}.',
  goodbye_message: '{user} has left {server}.',
  autorole: null,
  // automod
  automod_enabled: false,
  banned_words: [],
  block_invites: false,
  max_mentions: 0,
  // proactive speech (pressure engine) — off until deliberately enabled,
  // same as the Python bot: speaking unprompted is opt-in per guild.
  pressure_enabled: false,
  // de-escalation. deesc_harsh_language is the separate server preference
  // track that can produce a gentle check-in but never climbs the ladder.
  deesc_enabled: false,
  deesc_harsh_language: false,
  // background/utility model override; null falls back to the env default
  ai_utility_model: null,
  // voice monitoring master switch (dashboard start/stop)
  voice_enabled: false,
  // Dashboard access, mapped to this server's own Discord roles. Anyone in a
  // listed role gets that level when they sign in with Discord. Leave both
  // empty and the dashboard falls back to Discord permissions (Manage Server
  // = admin, kick/ban/timeout = moderator) so it works before it is set up.
  // OWNER_ID is always creator regardless, and cannot be locked out.
  dashboard_admin_roles: [],
  dashboard_mod_roles: [],
  // bot-wide presence, stored under guild id 0 by the dashboard
  presence_status: 'online',
  presence_activity_type: 'playing',
  presence_text: '',
};

let db = null;

/** Is this the Python bot's database rather than this one's?
 *
 * Every table name is identical between the two schemas, so CREATE TABLE IF
 * NOT EXISTS is a silent no-op against it and the bot would come up looking
 * perfectly healthy. It would not be: the Python side stores Discord
 * snowflakes as INTEGER, and any id past 2^53 is already a rounded float by
 * the time SQLite hands it back to JS (1234567890123456789 comes back as
 * ...800), so warnings, mod logs and per-member memory would all silently
 * key to the wrong user. guild_settings.guild_id is INTEGER there and TEXT
 * here, which tells the two apart with no ambiguity. */
function looksLikePythonDb(handle) {
  let columns;
  try {
    columns = handle.prepare("SELECT name, type FROM pragma_table_info('guild_settings')").all();
  } catch {
    return false; // no such table — a fresh database, which is fine
  }
  const guildId = columns.find((c) => c.name === 'guild_id');
  return Boolean(guildId) && String(guildId.type).toUpperCase() === 'INTEGER';
}

export function initDb(path = 'nodebot.db') {
  const handle = new DatabaseSync(path);
  if (looksLikePythonDb(handle)) {
    handle.close();
    throw new Error(
      `DATABASE_PATH points at the Python bot's database (${path}).\n\n`
      + 'Both schemas use the same table names, so this would look like it '
      + 'worked while silently corrupting every Discord id: the Python side '
      + 'stores snowflakes as INTEGER, and ids past 2^53 come back to JS as '
      + 'rounded floats. Warnings, mod logs and per-member memory would all '
      + 'key to the wrong user.\n\n'
      + 'Point DATABASE_PATH at a new file, then carry the settings across:\n'
      + `  node nodebot/src/migrate-settings.js --from ${path} --to /data/nodebot.db`,
    );
  }
  db = handle;
  db.exec(SCHEMA);
  return db;
}

export function closeDb() {
  db?.close();
  db = null;
}

function now() {
  return Math.floor(Date.now() / 1000);
}

// -- settings -----------------------------------------------------------

export function getSetting(guildId, key) {
  const row = db.prepare('SELECT value FROM guild_settings WHERE guild_id = ? AND key = ?')
    .get(String(guildId), key);
  if (!row) return DEFAULTS[key];
  return JSON.parse(row.value);
}

export function getAllSettings(guildId) {
  const settings = { ...DEFAULTS };
  const rows = db.prepare('SELECT key, value FROM guild_settings WHERE guild_id = ?').all(String(guildId));
  for (const row of rows) settings[row.key] = JSON.parse(row.value);
  return settings;
}

export function setSetting(guildId, key, value) {
  db.prepare(
    'INSERT INTO guild_settings (guild_id, key, value) VALUES (?, ?, ?) '
    + 'ON CONFLICT (guild_id, key) DO UPDATE SET value = excluded.value',
  ).run(String(guildId), key, JSON.stringify(value));
}

// -- AI memory ------------------------------------------------------------

/** @returns {{content: string, version: number}} */
export function getMemory(guildId, kind) {
  const row = db.prepare('SELECT content, version FROM memory WHERE guild_id = ? AND kind = ?')
    .get(String(guildId), kind);
  return row ? { content: row.content, version: row.version } : { content: '', version: 0 };
}

/** Atomically replace a memory file, archiving the previous version. */
export function setMemory(guildId, kind, content) {
  const gid = String(guildId);
  const { version } = getMemory(gid, kind);
  const newVersion = version + 1;
  const ts = now();
  db.prepare(
    'INSERT INTO memory (guild_id, kind, content, version, updated_at) VALUES (?, ?, ?, ?, ?) '
    + 'ON CONFLICT (guild_id, kind) DO UPDATE SET '
    + 'content = excluded.content, version = excluded.version, updated_at = excluded.updated_at',
  ).run(gid, kind, content, newVersion, ts);
  db.prepare(
    'INSERT INTO memory_versions (guild_id, kind, version, content, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(gid, kind, newVersion, content, ts);
  db.prepare('DELETE FROM memory_versions WHERE guild_id = ? AND kind = ? AND version <= ?')
    .run(gid, kind, newVersion - MEMORY_VERSIONS_KEPT);
  return newVersion;
}

export function clearMemory(guildId) {
  const gid = String(guildId);
  db.prepare('DELETE FROM memory WHERE guild_id = ?').run(gid);
  db.prepare('DELETE FROM memory_versions WHERE guild_id = ?').run(gid);
  db.prepare('DELETE FROM turns WHERE guild_id = ?').run(gid);
}

// -- manuscripts ------------------------------------------------------------

export function getManuscript(guildId, userId) {
  const row = db.prepare('SELECT content FROM manuscripts WHERE guild_id = ? AND user_id = ?')
    .get(String(guildId), String(userId));
  return row ? row.content : '';
}

export function appendManuscript(guildId, userId, text) {
  const existing = getManuscript(guildId, userId);
  const content = existing ? `${existing}\n\n${text}` : text;
  db.prepare(
    'INSERT INTO manuscripts (guild_id, user_id, content, updated_at) VALUES (?, ?, ?, ?) '
    + 'ON CONFLICT (guild_id, user_id) DO UPDATE SET '
    + 'content = excluded.content, updated_at = excluded.updated_at',
  ).run(String(guildId), String(userId), content, now());
}

export function clearManuscript(guildId, userId) {
  db.prepare('DELETE FROM manuscripts WHERE guild_id = ? AND user_id = ?')
    .run(String(guildId), String(userId));
}

// -- knowledge base -----------------------------------------------------------

export function kbGet(guildId, slug) {
  const row = db.prepare(
    'SELECT slug, title, content, updated_at FROM knowledge_base WHERE guild_id = ? AND slug = ?',
  ).get(String(guildId), slug);
  return row || null;
}

export function kbList(guildId) {
  return db.prepare('SELECT slug, title, updated_at FROM knowledge_base WHERE guild_id = ? ORDER BY title')
    .all(String(guildId));
}

export function kbSearch(guildId, query, limit = 10) {
  return db.prepare(
    'SELECT slug, title, content, updated_at FROM knowledge_base '
    + 'WHERE guild_id = ? AND (title LIKE ? OR content LIKE ?) ORDER BY title LIMIT ?',
  ).all(String(guildId), `%${query}%`, `%${query}%`, limit);
}

export function kbSave(guildId, slug, title, content) {
  db.prepare(
    'INSERT INTO knowledge_base (guild_id, slug, title, content, updated_at) VALUES (?, ?, ?, ?, ?) '
    + 'ON CONFLICT (guild_id, slug) DO UPDATE SET '
    + 'title = excluded.title, content = excluded.content, updated_at = excluded.updated_at',
  ).run(String(guildId), slug, title, content, now());
}

export function kbDelete(guildId, slug) {
  const result = db.prepare('DELETE FROM knowledge_base WHERE guild_id = ? AND slug = ?')
    .run(String(guildId), slug);
  return result.changes > 0;
}

// -- turns (durability + permanent chat log) ---------------------------------

export function addTurn(guildId, seq, speaker, userId, text, source, channel, ts) {
  db.prepare(
    'INSERT OR REPLACE INTO turns '
    + '(guild_id, seq, speaker, user_id, text, source, channel, ts, consolidated) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)',
  ).run(String(guildId), seq, speaker, userId === null || userId === undefined ? null : String(userId),
    text, source, channel, ts);
}

export function getPendingTurnGuilds() {
  return db.prepare('SELECT DISTINCT guild_id FROM turns WHERE consolidated = 0')
    .all().map((r) => r.guild_id);
}

export function getPendingTurns(guildId) {
  return db.prepare(
    'SELECT seq, speaker, user_id, text, source, channel, ts FROM turns '
    + 'WHERE guild_id = ? AND consolidated = 0 ORDER BY seq',
  ).all(String(guildId));
}

export function markTurnsConsolidated(guildId, seq) {
  db.prepare('UPDATE turns SET consolidated = 1 WHERE guild_id = ? AND seq <= ?')
    .run(String(guildId), seq);
}

export function getChatLog(guildId, { speakerQuery, textQuery, limit = 50 } = {}) {
  let sql = 'SELECT seq, speaker, user_id, text, source, channel, ts FROM turns WHERE guild_id = ?';
  const params = [String(guildId)];
  if (speakerQuery) { sql += ' AND speaker LIKE ?'; params.push(`%${speakerQuery}%`); }
  if (textQuery) { sql += ' AND text LIKE ?'; params.push(`%${textQuery}%`); }
  sql += ' ORDER BY seq DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params);
}

// -- warnings ---------------------------------------------------------------

export function addWarning(guildId, userId, moderatorId, reason) {
  const result = db.prepare(
    'INSERT INTO warnings (guild_id, user_id, moderator_id, reason, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(String(guildId), String(userId), String(moderatorId), reason ?? null, now());
  return Number(result.lastInsertRowid);
}

export function getWarnings(guildId, userId = null, limit = 100) {
  if (userId === null) {
    return db.prepare('SELECT * FROM warnings WHERE guild_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(String(guildId), limit);
  }
  return db.prepare(
    'SELECT * FROM warnings WHERE guild_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT ?',
  ).all(String(guildId), String(userId), limit);
}

export function deleteWarning(guildId, warningId) {
  const result = db.prepare('DELETE FROM warnings WHERE guild_id = ? AND id = ?')
    .run(String(guildId), warningId);
  return result.changes > 0;
}

export function clearWarnings(guildId, userId) {
  const result = db.prepare('DELETE FROM warnings WHERE guild_id = ? AND user_id = ?')
    .run(String(guildId), String(userId));
  return result.changes;
}

// -- moderation logs ----------------------------------------------------------

export function addLog(guildId, action, actor, target, reason) {
  db.prepare(
    'INSERT INTO mod_logs (guild_id, action, actor, target, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(String(guildId), action, actor, target ?? null, reason ?? null, now());
}

export function getLogs(guildId, limit = 100) {
  return db.prepare('SELECT * FROM mod_logs WHERE guild_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(String(guildId), limit);
}
