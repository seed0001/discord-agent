// migrate-settings.js — against real SQLite files shaped like the Python
// bot's, since the whole point is that Travis doesn't retype his config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrateSettings } from '../src/migrate-settings.js';
import * as db from '../src/db.js';

/** Build a database shaped like the Python bot's guild_settings table. */
function makePythonDb(dbPath, rows) {
  const source = new DatabaseSync(dbPath);
  source.exec(`CREATE TABLE guild_settings (
    guild_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
    PRIMARY KEY (guild_id, key)
  )`);
  const stmt = source.prepare('INSERT INTO guild_settings (guild_id, key, value) VALUES (?, ?, ?)');
  for (const [guildId, key, value] of rows) stmt.run(guildId, key, value);
  source.close();
}

function withDirs(fn) {
  return () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nodebot-migrate-'));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('carries the persona and messages across', withDirs((dir) => {
  const from = path.join(dir, 'bot.db');
  const to = path.join(dir, 'nodebot.db');
  makePythonDb(from, [
    ['111', 'ai_system_prompt', JSON.stringify('You are Max. Be blunt.')],
    ['111', 'welcome_message', JSON.stringify('welcome {user}!')],
    ['111', 'ai_model', JSON.stringify('qwen/qwen3.7-flash')],
  ]);

  const { migrated } = migrateSettings(from, to);
  assert.equal(migrated.length, 3);

  db.initDb(to);
  try {
    assert.equal(db.getSetting('111', 'ai_system_prompt'), 'You are Max. Be blunt.');
    assert.equal(db.getSetting('111', 'welcome_message'), 'welcome {user}!');
    assert.equal(db.getSetting('111', 'ai_model'), 'qwen/qwen3.7-flash');
  } finally {
    db.closeDb();
  }
}));

test('carries lists and booleans without mangling them', withDirs((dir) => {
  const from = path.join(dir, 'bot.db');
  const to = path.join(dir, 'nodebot.db');
  makePythonDb(from, [
    ['111', 'banned_words', JSON.stringify(['slur1', 'slur2'])],
    ['111', 'automod_enabled', JSON.stringify(true)],
    ['111', 'max_mentions', JSON.stringify(5)],
    ['111', 'voice_wake_words', JSON.stringify(['hey max', 'yo max'])],
  ]);
  migrateSettings(from, to);

  db.initDb(to);
  try {
    assert.deepEqual(db.getSetting('111', 'banned_words'), ['slur1', 'slur2']);
    assert.equal(db.getSetting('111', 'automod_enabled'), true);
    assert.equal(db.getSetting('111', 'max_mentions'), 5);
    assert.deepEqual(db.getSetting('111', 'voice_wake_words'), ['hey max', 'yo max']);
  } finally {
    db.closeDb();
  }
}));

test('snowflake-valued settings survive as strings, not lossy numbers', withDirs((dir) => {
  const from = path.join(dir, 'bot.db');
  const to = path.join(dir, 'nodebot.db');
  // A real snowflake exceeds Number.MAX_SAFE_INTEGER; the Python bot wrote
  // these as JSON numbers, and reading one back as a float corrupts it.
  makePythonDb(from, [
    ['111', 'log_channel', '1408180389180211270'],
    ['111', 'autorole', '1408180389180211271'],
  ]);
  migrateSettings(from, to);

  db.initDb(to);
  try {
    assert.equal(db.getSetting('111', 'log_channel'), '1408180389180211270');
    assert.equal(db.getSetting('111', 'autorole'), '1408180389180211271');
  } finally {
    db.closeDb();
  }
}));

test('a null id setting stays null rather than becoming the string "null"', withDirs((dir) => {
  const from = path.join(dir, 'bot.db');
  const to = path.join(dir, 'nodebot.db');
  makePythonDb(from, [['111', 'log_channel', 'null']]);
  migrateSettings(from, to);

  db.initDb(to);
  try {
    assert.equal(db.getSetting('111', 'log_channel'), null);
  } finally {
    db.closeDb();
  }
}));

test('settings from several guilds all cross', withDirs((dir) => {
  const from = path.join(dir, 'bot.db');
  const to = path.join(dir, 'nodebot.db');
  makePythonDb(from, [
    ['111', 'ai_model', JSON.stringify('model-a')],
    ['222', 'ai_model', JSON.stringify('model-b')],
  ]);
  migrateSettings(from, to);

  db.initDb(to);
  try {
    assert.equal(db.getSetting('111', 'ai_model'), 'model-a');
    assert.equal(db.getSetting('222', 'ai_model'), 'model-b');
  } finally {
    db.closeDb();
  }
}));

test('re-running is idempotent', withDirs((dir) => {
  const from = path.join(dir, 'bot.db');
  const to = path.join(dir, 'nodebot.db');
  makePythonDb(from, [['111', 'ai_model', JSON.stringify('model-a')]]);
  migrateSettings(from, to);
  const second = migrateSettings(from, to);
  assert.equal(second.migrated.length, 1);

  db.initDb(to);
  try {
    assert.equal(db.getSetting('111', 'ai_model'), 'model-a');
  } finally {
    db.closeDb();
  }
}));

test('a dry run reports without writing anything', withDirs((dir) => {
  const from = path.join(dir, 'bot.db');
  const to = path.join(dir, 'nodebot.db');
  makePythonDb(from, [['111', 'ai_model', JSON.stringify('model-a')]]);
  const { migrated } = migrateSettings(from, to, { dryRun: true });
  assert.equal(migrated.length, 1);

  db.initDb(to);
  try {
    // Falls back to the default, because nothing was actually written.
    assert.notEqual(db.getSetting('111', 'ai_model'), 'model-a');
  } finally {
    db.closeDb();
  }
}));

test('a missing source database is reported clearly', withDirs((dir) => {
  assert.throws(
    () => migrateSettings(path.join(dir, 'nope.db'), path.join(dir, 'out.db')),
    /source database not found/,
  );
}));

test('a malformed value is passed through rather than guessed at', withDirs((dir) => {
  const from = path.join(dir, 'bot.db');
  const to = path.join(dir, 'nodebot.db');
  makePythonDb(from, [['111', 'log_channel', 'not-json-at-all']]);
  // Must not throw; the row crosses untouched for a human to look at.
  const { migrated } = migrateSettings(from, to);
  assert.equal(migrated.length, 1);
}));
