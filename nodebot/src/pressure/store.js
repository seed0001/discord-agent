// Persistence adapter: full engine state survives restarts. Ported from
// pressure/store.py.
//
// node:sqlite with a schema version. The bot's own database is intentionally
// NOT reused — a separate file keeps the engine's state isolated, same as
// the Python original. Pass ':memory:' for throwaway runs.
//
// The Python version held an RLock for single-writer safety across threads.
// Node runs this on one event loop and every method here is synchronous, so
// no lock exists or is needed — there is no interleaving point.
import { DatabaseSync } from 'node:sqlite';
import { makeSignal, makeContribution } from './models.js';

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY, value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS signals (
    key TEXT PRIMARY KEY,
    source TEXT NOT NULL, weight REAL NOT NULL, confidence REAL NOT NULL,
    ts REAL NOT NULL, topic TEXT NOT NULL,
    channel_id TEXT NOT NULL DEFAULT '', user_id TEXT NOT NULL DEFAULT '',
    evidence TEXT NOT NULL DEFAULT '',
    decay TEXT NOT NULL, decay_rate REAL NOT NULL, max_lifetime REAL NOT NULL,
    state TEXT NOT NULL, resolved_reason TEXT NOT NULL DEFAULT '',
    resolved_ts REAL
);
CREATE TABLE IF NOT EXISTS buckets (
    name TEXT PRIMARY KEY, pressure REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS cooldowns (
    scope TEXT PRIMARY KEY, until REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS contributions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL, topic TEXT NOT NULL, bucket TEXT NOT NULL,
    content_key TEXT NOT NULL, summary TEXT NOT NULL,
    channel_id TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL, allowed INTEGER NOT NULL, reasons TEXT NOT NULL,
    proposal_topic TEXT NOT NULL, proposal_bucket TEXT NOT NULL,
    proposal_summary TEXT NOT NULL, channel_id TEXT NOT NULL DEFAULT '',
    pressures TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY, value TEXT NOT NULL
);
`;

const SIGNAL_COLUMNS = [
  'key', 'source', 'weight', 'confidence', 'ts', 'topic', 'channel_id',
  'user_id', 'evidence', 'decay', 'decay_rate', 'max_lifetime', 'state',
  'resolved_reason', 'resolved_ts',
];

export class SqliteStore {
  constructor(dbPath = ':memory:') {
    this.path = dbPath;
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
    const row = this.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
    if (!row) {
      this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
        .run('schema_version', String(SCHEMA_VERSION));
    } else if (parseInt(row.value, 10) !== SCHEMA_VERSION) {
      throw new Error(`pressure store schema ${row.value} != supported ${SCHEMA_VERSION}`);
    }
  }

  // -- signals ---------------------------------------------------------------

  upsertSignal(s) {
    const updates = SIGNAL_COLUMNS.filter((c) => c !== 'key')
      .map((c) => `${c}=excluded.${c}`).join(', ');
    this.db.prepare(
      `INSERT INTO signals (${SIGNAL_COLUMNS.join(', ')}) `
      + `VALUES (${SIGNAL_COLUMNS.map(() => '?').join(', ')}) `
      + `ON CONFLICT (key) DO UPDATE SET ${updates}`,
    ).run(...SIGNAL_COLUMNS.map((c) => s[c] ?? null));
  }

  getSignal(key) {
    const row = this.db.prepare('SELECT * FROM signals WHERE key = ?').get(key);
    return row ? makeSignal(row) : null;
  }

  /** state defaults to 'active'; pass null for every signal regardless. */
  signals(state = 'active') {
    const rows = state
      ? this.db.prepare('SELECT * FROM signals WHERE state = ?').all(state)
      : this.db.prepare('SELECT * FROM signals').all();
    return rows.map((r) => makeSignal(r));
  }

  deleteSignal(key) {
    this.db.prepare('DELETE FROM signals WHERE key = ?').run(key);
  }

  // -- buckets ---------------------------------------------------------------

  getPressures() {
    const out = {};
    for (const r of this.db.prepare('SELECT * FROM buckets').all()) out[r.name] = r.pressure;
    return out;
  }

  setPressures(pressures) {
    const stmt = this.db.prepare(
      'INSERT INTO buckets (name, pressure) VALUES (?, ?) '
      + 'ON CONFLICT (name) DO UPDATE SET pressure = excluded.pressure',
    );
    for (const [name, value] of Object.entries(pressures)) stmt.run(name, value);
  }

  // -- cooldowns -------------------------------------------------------------

  getCooldowns() {
    const out = {};
    for (const r of this.db.prepare('SELECT * FROM cooldowns').all()) out[r.scope] = r.until;
    return out;
  }

  setCooldown(scope, until) {
    this.db.prepare(
      'INSERT INTO cooldowns (scope, until) VALUES (?, ?) '
      + 'ON CONFLICT (scope) DO UPDATE SET until = excluded.until',
    ).run(scope, until);
  }

  // -- contributions & decisions --------------------------------------------

  addContribution(c, keep) {
    this.db.prepare(
      'INSERT INTO contributions (ts, topic, bucket, content_key, summary, channel_id) '
      + 'VALUES (?, ?, ?, ?, ?, ?)',
    ).run(c.ts, c.topic, c.bucket, c.content_key, c.summary, c.channel_id);
    this.db.prepare(
      'DELETE FROM contributions WHERE id <= (SELECT MAX(id) FROM contributions) - ?',
    ).run(keep);
  }

  contributions() {
    return this.db.prepare(
      'SELECT ts, topic, bucket, content_key, summary, channel_id FROM contributions ORDER BY id',
    ).all().map((r) => makeContribution(r));
  }

  addDecision(d, keep) {
    this.db.prepare(
      'INSERT INTO decisions (ts, allowed, reasons, proposal_topic, proposal_bucket, '
      + 'proposal_summary, channel_id, pressures) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      d.ts, d.allowed ? 1 : 0, JSON.stringify(d.reasons), d.proposalTopic,
      d.proposalBucket, d.proposalSummary, d.channelId, JSON.stringify(d.pressures),
    );
    this.db.prepare('DELETE FROM decisions WHERE id <= (SELECT MAX(id) FROM decisions) - ?')
      .run(keep);
  }

  decisions() {
    return this.db.prepare('SELECT * FROM decisions ORDER BY id').all().map((r) => ({
      ...r,
      reasons: JSON.parse(r.reasons),
      pressures: JSON.parse(r.pressures),
      allowed: Boolean(r.allowed),
    }));
  }

  // -- misc kv (topic last-seen, energy, message times) ----------------------

  kvGet(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : fallback;
  }

  kvSet(key, value) {
    this.db.prepare(
      'INSERT INTO kv (key, value) VALUES (?, ?) '
      + 'ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    ).run(key, JSON.stringify(value ?? null));
  }

  close() {
    this.db.close();
  }
}
