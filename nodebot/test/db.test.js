// Real SQLite (a temp file per test, node:sqlite) — these are the actual
// queries the bot runs, mirroring the Python bot's tests/test_db.py.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as db from '../src/db.js';

function withDb(fn) {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nodebot-test-'));
    db.initDb(path.join(dir, 'test.db'));
    try {
      await fn();
    } finally {
      db.closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('unset setting falls back to DEFAULTS', withDb(() => {
  assert.equal(db.getSetting('1', 'ai_enabled'), true);
}));

test('set/get round-trips a JSON-encoded value', withDb(() => {
  db.setSetting('1', 'quiet_mode', true);
  assert.equal(db.getSetting('1', 'quiet_mode'), true);
  db.setSetting('1', 'voice_wake_words', ['hey max', 'hey andrew']);
  assert.deepEqual(db.getSetting('1', 'voice_wake_words'), ['hey max', 'hey andrew']);
}));

test('setSetting overwrites on conflict', withDb(() => {
  db.setSetting('1', 'ai_model', 'model-a');
  db.setSetting('1', 'ai_model', 'model-b');
  assert.equal(db.getSetting('1', 'ai_model'), 'model-b');
}));

test('getAllSettings merges DEFAULTS with stored overrides', withDb(() => {
  db.setSetting('1', 'quiet_mode', true);
  const settings = db.getAllSettings('1');
  assert.equal(settings.quiet_mode, true);
  assert.equal(settings.ai_enabled, true); // untouched default still present
}));

test('settings are isolated per guild', withDb(() => {
  db.setSetting('1', 'quiet_mode', true);
  assert.equal(db.getSetting('2', 'quiet_mode'), false); // DEFAULTS fallback
}));

test('memory versions increment and archive', withDb(() => {
  assert.deepEqual(db.getMemory('1', 'durable'), { content: '', version: 0 });
  const v1 = db.setMemory('1', 'durable', 'first');
  assert.equal(v1, 1);
  const v2 = db.setMemory('1', 'durable', 'second');
  assert.equal(v2, 2);
  assert.deepEqual(db.getMemory('1', 'durable'), { content: 'second', version: 2 });
}));

test('clearMemory wipes memory and turns for that guild', withDb(() => {
  db.setMemory('1', 'durable', 'stuff');
  db.addTurn('1', 1, 'alice', '42', 'hi', 'text', 'general', 100);
  db.clearMemory('1');
  assert.deepEqual(db.getMemory('1', 'durable'), { content: '', version: 0 });
  assert.deepEqual(db.getChatLog('1'), []);
}));

test('manuscript grows with each append and is per-member', withDb(() => {
  db.appendManuscript('1', '42', 'chapter one');
  db.appendManuscript('1', '42', 'chapter two');
  assert.equal(db.getManuscript('1', '42'), 'chapter one\n\nchapter two');
  assert.equal(db.getManuscript('1', '99'), '');
}));

test('clearManuscript removes it', withDb(() => {
  db.appendManuscript('1', '42', 'content');
  db.clearManuscript('1', '42');
  assert.equal(db.getManuscript('1', '42'), '');
}));

test('knowledge base save/get/list/search/delete', withDb(() => {
  db.kbSave('1', 'deploy', 'Deploy', 'run npm install then npm start');
  assert.equal(db.kbGet('1', 'deploy').content, 'run npm install then npm start');
  db.kbSave('1', 'deploy', 'Deploy', 'corrected steps');
  assert.equal(db.kbGet('1', 'deploy').content, 'corrected steps'); // same slug overwrites

  db.kbSave('1', 'other', 'Other thing', 'unrelated');
  assert.equal(db.kbList('1').length, 2);

  const found = db.kbSearch('1', 'npm install'); // stale content, matches nothing now
  assert.equal(found.length, 0);
  assert.equal(db.kbSearch('1', 'corrected')[0].slug, 'deploy');

  assert.equal(db.kbDelete('1', 'deploy'), true);
  assert.equal(db.kbGet('1', 'deploy'), null);
  assert.equal(db.kbDelete('1', 'deploy'), false);
}));

test('turns: pending until marked consolidated, never deleted after', withDb(() => {
  db.addTurn('1', 1, 'travis', '42', 'hello', 'text', 'general', 100);
  assert.deepEqual(db.getPendingTurnGuilds(), ['1']);
  assert.equal(db.getPendingTurns('1').length, 1);

  db.markTurnsConsolidated('1', 1);
  assert.deepEqual(db.getPendingTurnGuilds(), []);
  assert.equal(db.getPendingTurns('1').length, 0);
  // still in the permanent chat log, just no longer "pending"
  assert.equal(db.getChatLog('1').length, 1);
}));

test('chat log filters by speaker and keyword', withDb(() => {
  db.addTurn('1', 1, 'alice', '1', 'my birthday is march 3rd', 'text', 'general', 100);
  db.addTurn('1', 2, 'bob', '2', 'my birthday is in june', 'text', 'general', 101);
  assert.equal(db.getChatLog('1', { speakerQuery: 'alice' })[0].text, 'my birthday is march 3rd');
  assert.equal(db.getChatLog('1', { textQuery: 'june' })[0].text, 'my birthday is in june');
}));

test('warnings: add, list, clear', withDb(() => {
  const id = db.addWarning('1', '42', '1', 'being annoying');
  assert.equal(typeof id, 'number');
  assert.equal(db.getWarnings('1', '42').length, 1);
  assert.equal(db.clearWarnings('1', '42'), 1);
  assert.equal(db.getWarnings('1', '42').length, 0);
}));

test('warnings: deleteWarning reports whether it existed', withDb(() => {
  const id = db.addWarning('1', '42', '1', 'reason');
  assert.equal(db.deleteWarning('1', id), true);
  assert.equal(db.deleteWarning('1', id), false);
}));

test('mod logs: add and list newest first', withDb(() => {
  db.addLog('1', 'kick', 'Max', 'someone', 'being annoying');
  db.addLog('1', 'ban', 'Max', 'someone-else', null);
  const logs = db.getLogs('1');
  assert.equal(logs.length, 2);
  assert.equal(logs[0].action, 'ban'); // most recent first
}));

// -- guarding against the Python bot's database ------------------------------

/** Build a database with the Python bot's shape: same table name, snowflake
 * columns as INTEGER rather than TEXT. */
function pythonShapedDb(file) {
  const handle = new DatabaseSync(file);
  handle.exec(`CREATE TABLE IF NOT EXISTS guild_settings (
      guild_id INTEGER NOT NULL,
      key      TEXT NOT NULL,
      value    TEXT NOT NULL,
      PRIMARY KEY (guild_id, key)
  );`);
  handle.close();
}

test("opening the Python bot's database is refused, not silently accepted", () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nodebot-pydb-'));
  const file = path.join(dir, 'bot.db');
  try {
    pythonShapedDb(file);
    assert.throws(() => db.initDb(file), /Python bot's database/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the refusal says how to fix it', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nodebot-pydb-'));
  const file = path.join(dir, 'bot.db');
  try {
    pythonShapedDb(file);
    assert.throws(() => db.initDb(file), /migrate-settings\.js --from/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a brand new database file is accepted', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nodebot-newdb-'));
  try {
    assert.doesNotThrow(() => db.initDb(path.join(dir, 'fresh.db')));
    db.closeDb();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reopening this bot's own database is accepted", () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nodebot-reopen-'));
  const file = path.join(dir, 'nodebot.db');
  try {
    db.initDb(file);
    db.setSetting('111', 'ai_model', 'x');
    db.closeDb();
    assert.doesNotThrow(() => db.initDb(file));
    assert.equal(db.getSetting('111', 'ai_model'), 'x');
    db.closeDb();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
