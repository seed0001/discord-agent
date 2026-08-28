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
// Platform tables (accounts, servers, orders, the credit ledger) live in the
// same file but are owned by src/platform and src/credits. Only the schema
// string is imported here — the modules that read and write those tables get
// the handle back through getDb(), so nothing has to import this module's
// internals and there is no cycle.
import { PLATFORM_SCHEMA } from './platform/schema.js';

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
-- OpenRouter's model list, refreshed hourly. Cached here so a restart or an
-- OpenRouter outage still leaves her something to fall back to at the moment
-- the current backend starts refusing. See backends/catalog.js.
CREATE TABLE IF NOT EXISTS model_catalog (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    context_length   INTEGER,
    prompt_price     REAL,
    completion_price REAL,
    supports_tools   INTEGER NOT NULL DEFAULT 0,
    can_chat         INTEGER NOT NULL DEFAULT 0,
    fetched_at       INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS songs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id   TEXT NOT NULL,
    title      TEXT NOT NULL,
    prompt     TEXT NOT NULL,
    data       BLOB NOT NULL,
    media_type TEXT NOT NULL,
    length     TEXT NOT NULL,
    cost_usd   REAL,
    created_by TEXT,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS calendar_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id    TEXT NOT NULL,
    title       TEXT NOT NULL,
    details     TEXT,
    next_fire   INTEGER NOT NULL,
    recurrence  TEXT NOT NULL DEFAULT 'once',
    channel_id  TEXT NOT NULL,
    mention     TEXT,
    created_by  TEXT NOT NULL,
    active      INTEGER NOT NULL DEFAULT 1,
    last_fired  INTEGER,
    created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_warnings_guild_user ON warnings (guild_id, user_id);
CREATE INDEX IF NOT EXISTS idx_logs_guild ON mod_logs (guild_id, created_at);
CREATE INDEX IF NOT EXISTS idx_memver ON memory_versions (guild_id, kind, version);
CREATE INDEX IF NOT EXISTS idx_turns_guild_consolidated ON turns (guild_id, consolidated);
CREATE INDEX IF NOT EXISTS idx_songs_guild ON songs (guild_id, created_at);
CREATE INDEX IF NOT EXISTS idx_calendar_fire ON calendar_events (active, next_fire);
CREATE INDEX IF NOT EXISTS idx_calendar_guild ON calendar_events (guild_id, active, next_fire);
`;

export const MEMORY_VERSIONS_KEPT = 10;

export const DEFAULTS = {
  ai_enabled: true,
  // What the bot calls itself, in prompts, memory and the dashboard. null
  // means "use the Discord application's own name", which is the default and
  // the one to prefer — rename the app and everything follows. Set a string
  // here only to call it something different in this server specifically.
  // Read through botName.js rather than directly; nothing should reach for
  // this key on its own.
  bot_name: null,
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
  // Voice channels the bot is allowed to join/listen in. Empty = no
  // restriction (same "empty list means unrestricted" convention as
  // ai_channels above) — set this to narrow the bot down to one or two
  // channels on a server that doesn't want it roaming into every voice
  // channel. Enforced in voice.js's joinChannel().
  voice_channel_allowlist: [],
  voice_wake_words: VOICE_WAKE_WORDS,
  voice_cancel_words: VOICE_CANCEL_WORDS,
  // Follow-up mode: for this many seconds after Max finishes speaking,
  // anyone in the channel can carry the conversation on without saying the
  // wake word again. Each real answer re-arms it. 0 disables it.
  voice_followup_enabled: true,
  voice_followup_window_sec: VOICE_FOLLOWUP_WINDOW_SEC,
  voice_stop_speaking_words: VOICE_STOP_SPEAKING_WORDS,
  voice_stop_listening_words: VOICE_STOP_LISTENING_WORDS,
  // How the bot decides it is being spoken to.
  //   'smart'      — a cheap classifier asks whether the bot's name came up
  //                  (tolerating mishearings), then the conversational model
  //                  decides whether that was an address or just a mention.
  //   'wake_words' — exact phrase matching only, the original behaviour.
  // Exact wake words still fire instantly in BOTH modes; smart detection is
  // what catches "hey aim ee" when the transcriber mangles the name.
  voice_detection_mode: 'smart',
  // Audible signals, since smart detection made silence ambiguous. Each is
  // {mode:'tone'} | {mode:'off'} | {mode:'soundboard', soundId, soundGuildId}.
  // 'declined' defaults off because it fires on conversations the bot decided
  // NOT to join, which is the most common outcome in a busy room — worth
  // turning on while tuning, noisy as a permanent default.
  voice_cue_thinking: { mode: 'tone' },
  voice_cue_engaging: { mode: 'tone' },
  voice_cue_declined: { mode: 'off' },
  // On by default, unlike 'declined': this is the one people actually asked
  // for — an audible "he's stopped listening" so nobody has to guess whether
  // the follow-up window is still open.
  voice_cue_stopped_listening: { mode: 'tone' },
  // Per-server spoken-voice overrides. null = use deployment env (FISH_* /
  // EDGE_TTS_VOICE on Railway). The API key itself stays env-only.
  fish_voice_id: null,
  fish_tts_model: null,
  edge_tts_voice: null,
  // Strip *, `, #, etc. from text before TTS so formatting is not read aloud.
  tts_strip_markdown: true,
  quiet_mode: false,
  log_channel: null,
  // IANA timezone name (e.g. "America/Chicago") used to interpret and display
  // calendar/reminder times. "UTC" until an admin sets it — see calendar.js
  // and the /calendar command. A bad value falls back to UTC at use time.
  calendar_timezone: 'UTC',
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
  // cross-channel spam ban: a member blasting the same message/attachment
  // into several channels within a short window gets auto-banned and their
  // recent messages purged server-wide (deleteMessageSeconds on the ban
  // itself, not a per-channel purge). The usual trigger is a compromised
  // account, not a malicious member, so this is a ban (reversible with
  // /unban) rather than anything more permanent. On by default, unlike the
  // rest of automod, since a hacked account blasting every channel is
  // damage every server wants stopped immediately.
  antispam_enabled: true,
  antispam_channel_threshold: 4,
  antispam_window_seconds: 20,
  antispam_delete_seconds: 3600,
  // proactive speech (pressure engine) — off until deliberately enabled,
  // same as the Python bot: speaking unprompted is opt-in per guild.
  pressure_enabled: false,
  // de-escalation. deesc_harsh_language is the separate server preference
  // track that can produce a gentle check-in but never climbs the ladder.
  deesc_enabled: false,
  deesc_harsh_language: false,
  // background/utility model override; null falls back to the env default
  ai_utility_model: null,
  // Image and video generation. Unlike everything else here, each use spends
  // real money and/or ties up the local VideoMaker pipeline for many minutes,
  // so access starts at the narrowest setting that is still useful: 'owner'
  // means only OWNER_ID can ask for one, 'everyone' opens it to the whole
  // server — a decision someone should make on purpose rather than inherit
  // from a default.
  media_enabled: true,
  media_access: 'owner',
  // Per-guild image model pin. null means "use whatever OPENROUTER_IMAGE_MODEL
  // is set to" — mediaTools.js resolves the fallback at call time, deliberately
  // not read here, so changing the env var moves every guild that hasn't
  // chosen its own model. videomaker.js's script/illustrations reuse this
  // same pin for the image half of a video; there's no separate video model.
  media_image_model: null,
  // Which model looks at pictures people post. Different axis from the two
  // above: those are generation endpoints, this one is the ordinary chat call
  // that happens to be handed an image, so null falls back to ai_model rather
  // than to an env var. Worth pinning when the conversational model is cheap
  // and text-only — the reply for a turn with an image comes from whatever is
  // set here, so it should still be a model you're happy talking to.
  media_vision_model: null,
  // Spend breaker for the expensive half: videos per guild per hour, 0 to
  // disable the cap entirely. Images are cheap enough to leave uncapped.
  media_video_hourly_cap: 5,
  // What each model was before the last backend switch, so "switch back"
  // works after she has rerouted around a rate-limited provider. Persisted
  // rather than held in memory so a redeploy mid-incident doesn't strand a
  // server on a fallback nobody chose.
  ai_model_previous: null,
  ai_utility_model_previous: null,
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
  db.exec(PLATFORM_SCHEMA);
  refreshModelCatalogShape();
  return db;
}

/**
 * Drop the model catalog when its columns are out of date.
 *
 * It is a pure cache of OpenRouter's model list, refetched every hour, so
 * throwing it away costs nothing and rebuilding it is automatic. That is much
 * safer than an ALTER TABLE dance: a column added with a DEFAULT would leave
 * every cached row claiming the default, and `can_chat` defaulting to 0 would
 * silently empty the fallback list on an existing deployment while
 * `can_chat` defaulting to 1 would keep routing to music generators.
 */
function refreshModelCatalogShape() {
  let columns;
  try {
    columns = db.prepare("SELECT name FROM pragma_table_info('model_catalog')").all();
  } catch {
    return; // no such table yet — the schema above just created it
  }
  if (!columns.length) return;
  const names = new Set(columns.map((c) => c.name));
  const expected = ['id', 'name', 'context_length', 'prompt_price',
    'completion_price', 'supports_tools', 'can_chat', 'fetched_at'];
  if (expected.every((c) => names.has(c))) return;
  console.log('[db] model catalog shape changed — dropping the cache to rebuild');
  db.exec('DROP TABLE model_catalog');
  db.exec(SCHEMA);
}

export function closeDb() {
  db?.close();
  db = null;
}

/**
 * The open database handle, for the platform and credit modules.
 *
 * They keep their own SQL rather than growing this module, but they must
 * share this one connection: node:sqlite is synchronous and single-writer,
 * and a second DatabaseSync against the same file would take its own lock and
 * turn a metering write into SQLITE_BUSY under exactly the concurrency the
 * bot generates.
 */
export function getDb() {
  if (!db) throw new Error('database not initialised — call initDb() first');
  return db;
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

/** Has this guild actually saved this key, as opposed to inheriting the
 * default? getSetting alone cannot tell the two apart, and the difference
 * matters wherever a default is derived rather than fixed — see
 * botName.js voicePhrases(), which must not overwrite a list an admin chose. */
export function hasSetting(guildId, key) {
  return db.prepare('SELECT 1 FROM guild_settings WHERE guild_id = ? AND key = ?')
    .get(String(guildId), key) !== undefined;
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

// -- song library -------------------------------------------------------------
// Persistent per-guild playlist: songs kept out of generate_music's output so
// they can be replayed later (play_song/play_playlist in musicTools.js)
// without spending on Lyria again. Capped small on purpose — this is a
// "keep your favorites" list curated by voice command, not an archive, so a
// hard cap forces a deliberate swap (delete_song, then save_song) rather
// than growing forever.
export const SONG_LIBRARY_CAP = 10;

export function countSongs(guildId) {
  return db.prepare('SELECT COUNT(*) AS n FROM songs WHERE guild_id = ?')
    .get(String(guildId)).n;
}

/** Metadata only, no audio blob — cheap to list. */
export function listSongs(guildId) {
  return db.prepare(
    'SELECT id, title, length, cost_usd, created_at FROM songs WHERE guild_id = ? ORDER BY created_at ASC',
  ).all(String(guildId));
}

/** One song's audio, for actually playing it. */
export function getSongData(guildId, id) {
  const row = db.prepare(
    'SELECT id, title, data, media_type FROM songs WHERE guild_id = ? AND id = ?',
  ).get(String(guildId), Number(id));
  if (!row) return null;
  return { id: row.id, title: row.title, data: Buffer.from(row.data), mediaType: row.media_type };
}

/** Resolve a spoken/typed song reference to one library row: an exact id, an
 * exact title match, or — only when it's unambiguous — a partial title
 * match. Returns null rather than guessing when more than one song matches,
 * so musicTools.js can ask instead of playing or deleting the wrong track. */
export function findSong(guildId, query) {
  const gid = String(guildId);
  const text = String(query || '').trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const row = db.prepare('SELECT id, title FROM songs WHERE guild_id = ? AND id = ?')
      .get(gid, Number(text));
    if (row) return row;
  }
  const rows = db.prepare('SELECT id, title FROM songs WHERE guild_id = ?').all(gid);
  const lower = text.toLowerCase();
  const exact = rows.find((r) => r.title.toLowerCase() === lower);
  if (exact) return exact;
  const partial = rows.filter((r) => r.title.toLowerCase().includes(lower));
  return partial.length === 1 ? partial[0] : null;
}

export function addSong(guildId, {
  title, prompt, data, mediaType, length, costUsd, createdBy,
}) {
  const result = db.prepare(
    'INSERT INTO songs (guild_id, title, prompt, data, media_type, length, cost_usd, created_by, created_at) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(String(guildId), title, prompt, data, mediaType, length, costUsd ?? null,
    createdBy ? String(createdBy) : null, now());
  return Number(result.lastInsertRowid);
}

export function deleteSong(guildId, id) {
  const result = db.prepare('DELETE FROM songs WHERE guild_id = ? AND id = ?')
    .run(String(guildId), Number(id));
  return result.changes > 0;
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

// -- calendar events / reminders --------------------------------------------
// One row is a scheduled thing that fires into a Discord channel at next_fire
// (unix seconds). recurrence 'once' deactivates the row after it fires;
// anything else is rolled forward by calendar.js. See calendar.js for the
// tools, the scheduler tick, and how next_fire is computed.

export function calendarAdd(guildId, {
  title, details, nextFire, recurrence = 'once', channelId, mention, createdBy,
}) {
  const result = db.prepare(
    'INSERT INTO calendar_events '
    + '(guild_id, title, details, next_fire, recurrence, channel_id, mention, created_by, active, created_at) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)',
  ).run(String(guildId), title, details ?? null, Math.floor(nextFire), recurrence,
    String(channelId), mention ?? null, String(createdBy), now());
  return Number(result.lastInsertRowid);
}

export function calendarGet(guildId, id) {
  return db.prepare('SELECT * FROM calendar_events WHERE guild_id = ? AND id = ?')
    .get(String(guildId), Number(id)) || null;
}

/** Active events for one guild, soonest first. */
export function calendarList(guildId, limit = 25) {
  return db.prepare(
    'SELECT * FROM calendar_events WHERE guild_id = ? AND active = 1 ORDER BY next_fire ASC LIMIT ?',
  ).all(String(guildId), limit);
}

/** Every active event due at or before `ts`, across all guilds — the tick
 * reads this, resolves each guild/channel from the client, and rolls the row
 * forward (or deactivates it). */
export function calendarDue(ts) {
  return db.prepare(
    'SELECT * FROM calendar_events WHERE active = 1 AND next_fire <= ? ORDER BY next_fire ASC',
  ).all(Math.floor(ts));
}

export function calendarUpdate(guildId, id, fields) {
  const allowed = ['title', 'details', 'next_fire', 'recurrence', 'channel_id', 'mention'];
  const sets = [];
  const params = [];
  for (const key of allowed) {
    if (fields[key] === undefined) continue;
    sets.push(`${key} = ?`);
    params.push(fields[key]);
  }
  if (!sets.length) return false;
  params.push(String(guildId), Number(id));
  const result = db.prepare(
    `UPDATE calendar_events SET ${sets.join(', ')} WHERE guild_id = ? AND id = ?`,
  ).run(...params);
  return result.changes > 0;
}

/** Roll a recurring event forward to its next occurrence. */
export function calendarReschedule(id, nextFire, lastFired) {
  db.prepare('UPDATE calendar_events SET next_fire = ?, last_fired = ? WHERE id = ?')
    .run(Math.floor(nextFire), Math.floor(lastFired), Number(id));
}

/** Mark an event done (a fired 'once', or a row whose guild/channel is gone). */
export function calendarDeactivate(id, lastFired = null) {
  db.prepare('UPDATE calendar_events SET active = 0, last_fired = COALESCE(?, last_fired) WHERE id = ?')
    .run(lastFired === null ? null : Math.floor(lastFired), Number(id));
}

export function calendarDelete(guildId, id) {
  const result = db.prepare('DELETE FROM calendar_events WHERE guild_id = ? AND id = ?')
    .run(String(guildId), Number(id));
  return result.changes > 0;
}
