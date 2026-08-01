import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as db from '../src/db.js';
import { findViolation, checkMessage } from '../src/automod.js';

function withDb(fn) {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nodebot-automod-test-'));
    db.initDb(path.join(dir, 'test.db'));
    try {
      await fn();
    } finally {
      db.closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('findViolation does nothing when automod is disabled', withDb(() => {
  assert.equal(findViolation({ id: '1' }, null, 'this has a banned word: spam', 0), null);
}));

test('findViolation catches a banned word, case-insensitively', withDb(() => {
  db.setSetting('1', 'automod_enabled', true);
  db.setSetting('1', 'banned_words', ['spam']);
  assert.match(findViolation({ id: '1' }, null, 'stop SPAMMING here', 0), /banned word: spam/);
  assert.equal(findViolation({ id: '1' }, null, 'totally clean message', 0), null);
}));

test('findViolation catches an invite link only when block_invites is on', withDb(() => {
  db.setSetting('1', 'automod_enabled', true);
  assert.equal(findViolation({ id: '1' }, null, 'join us: discord.gg/abc123', 0), null);
  db.setSetting('1', 'block_invites', true);
  assert.match(findViolation({ id: '1' }, null, 'join us: discord.gg/abc123', 0), /invite link/);
}));

test('findViolation catches mention spam over the configured max', withDb(() => {
  db.setSetting('1', 'automod_enabled', true);
  db.setSetting('1', 'max_mentions', 3);
  assert.equal(findViolation({ id: '1' }, null, 'hi', 3), null); // at the limit, not over
  assert.match(findViolation({ id: '1' }, null, 'hi', 4), /mention spam \(4 mentions\)/);
}));

test('findViolation checks banned words before invites before mention spam', withDb(() => {
  db.setSetting('1', 'automod_enabled', true);
  db.setSetting('1', 'banned_words', ['spam']);
  db.setSetting('1', 'block_invites', true);
  const result = findViolation({ id: '1' }, null, 'spam discord.gg/abc', 0);
  assert.match(result, /banned word/); // first match wins
}));

test('checkMessage skips bots and DMs', withDb(async () => {
  await checkMessage({ guild: null, author: { bot: false } }); // no guild — DM
  await checkMessage({ guild: { id: '1' }, author: { bot: true } }); // bot author
  // neither should throw; nothing to assert beyond "didn't crash"
}));

test('checkMessage skips members with manage_messages permission', withDb(async () => {
  db.setSetting('1', 'automod_enabled', true);
  db.setSetting('1', 'banned_words', ['spam']);
  let deleted = false;
  const message = {
    guild: { id: '1' },
    author: { bot: false, id: '42' },
    member: { permissions: { has: () => true } },
    content: 'spam spam spam',
    mentions: { users: { size: 0 } },
    delete: async () => { deleted = true; },
  };
  await checkMessage(message);
  assert.equal(deleted, false);
}));

test('checkMessage deletes a violating message and logs it', withDb(async () => {
  db.setSetting('1', 'automod_enabled', true);
  db.setSetting('1', 'banned_words', ['spam']);
  let deleted = false;
  const sent = [];
  const message = {
    guild: { id: '1' },
    author: { bot: false, id: '42', toString: () => '<@42>' },
    member: { permissions: { has: () => false } },
    content: 'buy spam now',
    mentions: { users: { size: 0 } },
    delete: async () => { deleted = true; },
    channel: { send: async (text) => { sent.push(text); return { delete: async () => {} }; } },
  };
  await checkMessage(message);
  assert.equal(deleted, true);
  assert.equal(db.getLogs('1').length, 1);
  assert.equal(db.getLogs('1')[0].action, 'automod');
  assert.match(sent[0], /removed/);
}));
