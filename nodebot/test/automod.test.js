import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as db from '../src/db.js';
import { findViolation, checkMessage, recordMentionFanoutAndCheck, _resetForTests } from '../src/automod.js';

function withDb(fn) {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nodebot-automod-test-'));
    db.initDb(path.join(dir, 'test.db'));
    _resetForTests();
    try {
      await fn();
    } finally {
      db.closeDb();
      _resetForTests();
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

test('recordMentionFanoutAndCheck ignores messages with no targets', withDb(() => {
  assert.equal(recordMentionFanoutAndCheck('g', 'u', []), null);
}));

test('recordMentionFanoutAndCheck does not trigger below the threshold', withDb(() => {
  const opts = { threshold: 3, windowSeconds: 30 };
  let r = recordMentionFanoutAndCheck('g', 'u', ['a'], opts, 1000);
  assert.equal(r.triggered, false);
  assert.equal(r.targetCount, 1);
  r = recordMentionFanoutAndCheck('g', 'u', ['b'], opts, 1100);
  assert.equal(r.triggered, false);
  assert.equal(r.targetCount, 2);
}));

test('recordMentionFanoutAndCheck triggers once enough distinct people are pinged', withDb(() => {
  const opts = { threshold: 3, windowSeconds: 30 };
  recordMentionFanoutAndCheck('g', 'u', ['a'], opts, 1000);
  recordMentionFanoutAndCheck('g', 'u', ['b'], opts, 1100);
  const r = recordMentionFanoutAndCheck('g', 'u', ['c'], opts, 1200);
  assert.equal(r.triggered, true);
  assert.equal(r.targetCount, 3);
}));

test('recordMentionFanoutAndCheck does not count the same target twice', withDb(() => {
  const opts = { threshold: 2, windowSeconds: 30 };
  recordMentionFanoutAndCheck('g', 'u', ['a'], opts, 1000);
  const r = recordMentionFanoutAndCheck('g', 'u', ['a'], opts, 1100); // same target again
  assert.equal(r.triggered, false);
  assert.equal(r.targetCount, 1);
}));

test('recordMentionFanoutAndCheck resets the tally once the window elapses', withDb(() => {
  const opts = { threshold: 2, windowSeconds: 10 };
  recordMentionFanoutAndCheck('g', 'u', ['a'], opts, 0);
  const r = recordMentionFanoutAndCheck('g', 'u', ['b'], opts, 20000); // 20s later, outside window
  assert.equal(r.triggered, false);
  assert.equal(r.targetCount, 1);
}));

function makeFanoutMessage({ guildId = '1', authorId = '42', targetIds = ['t1'], bannable = true } = {}) {
  return {
    guild: { id: guildId },
    author: { bot: false, id: authorId, tag: `user#${authorId}`, toString: () => `<@${authorId}>` },
    member: {
      permissions: { has: () => false },
      bannable,
      ban: async () => {},
    },
    content: 'hi',
    mentions: { users: new Map(targetIds.map((id) => [id, {}])) },
    channel: { id: 'c1' },
    delete: async () => {},
  };
}

test('checkMessage bans once mention fan-out crosses the threshold', withDb(async () => {
  db.setSetting('1', 'mention_fanout_enabled', true);
  db.setSetting('1', 'mention_fanout_threshold', 3);
  db.setSetting('1', 'mention_fanout_window_seconds', 30);
  db.setSetting('1', 'mention_fanout_delete_seconds', 3600);
  let banArgs = null;
  const member = {
    permissions: { has: () => false },
    bannable: true,
    ban: async (args) => { banArgs = args; },
  };
  for (const targetId of ['t1', 't2', 't3']) {
    await checkMessage({
      guild: { id: '1' },
      author: { bot: false, id: '42', tag: 'raider#42', toString: () => '<@42>' },
      member,
      content: 'hi',
      mentions: { users: new Map([[targetId, {}]]) },
      delete: async () => {},
    });
  }
  assert.ok(banArgs, 'ban() should have been called');
  assert.equal(banArgs.deleteMessageSeconds, 3600);
  assert.match(banArgs.reason, /3 distinct members/);
  const logs = db.getLogs('1');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].action, 'mention_fanout_ban');
}));

test('checkMessage does not trigger mention fan-out below the threshold', withDb(async () => {
  db.setSetting('1', 'mention_fanout_enabled', true);
  db.setSetting('1', 'mention_fanout_threshold', 5);
  await checkMessage(makeFanoutMessage({ targetIds: ['t1'] }));
  await checkMessage(makeFanoutMessage({ targetIds: ['t2'] }));
  assert.equal(db.getLogs('1').length, 0);
}));

test('checkMessage flags instead of banning when the bot cannot ban the fan-out member', withDb(async () => {
  db.setSetting('1', 'mention_fanout_enabled', true);
  db.setSetting('1', 'mention_fanout_threshold', 2);
  let banCalled = false;
  const unbannableMember = {
    permissions: { has: () => false },
    bannable: false,
    ban: async () => { banCalled = true; },
  };
  for (const targetId of ['t1', 't2']) {
    await checkMessage({
      guild: { id: '1' },
      author: { bot: false, id: '42', tag: 'raider#42', toString: () => '<@42>' },
      member: unbannableMember,
      content: 'hi',
      mentions: { users: new Map([[targetId, {}]]) },
      delete: async () => {},
    });
  }
  assert.equal(banCalled, false);
  const logs = db.getLogs('1');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].action, 'mention_fanout_flag');
}));
