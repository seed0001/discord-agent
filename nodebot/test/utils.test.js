import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isOwner, requireOwner, logAction } from '../src/utils.js';
import * as db from '../src/db.js';

test('matches when userId equals the (injected) owner id', () => {
  assert.equal(isOwner('42', '42'), true);
  assert.equal(isOwner(42, '42'), true); // loose string compare either direction
  assert.equal(isOwner('99', '42'), false);
});

test('an unset owner id matches nobody, including an empty userId', () => {
  assert.equal(isOwner('', ''), false);
  assert.equal(isOwner('0', ''), false);
});

test('uses the real configured OWNER_ID by default when not injected', () => {
  // No .env in this environment, so OWNER_ID is unset — matches nobody.
  assert.equal(isOwner('anything'), false);
});

function withDb(fn) {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nodebot-utils-test-'));
    db.initDb(path.join(dir, 'test.db'));
    try {
      await fn();
    } finally {
      db.closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function fakeInteraction(userId) {
  const replies = [];
  return {
    user: { id: userId },
    reply: async (msg) => { replies.push(msg); },
    _replies: replies,
  };
}

function fakeGuild(id) {
  return {
    id,
    channels: { cache: new Map() },
    roles: { everyone: { id: `${id}-everyone` } },
  };
}

test('requireOwner replies and returns false for a non-owner', withDb(async () => {
  const interaction = fakeInteraction('99');
  const allowed = await requireOwner(interaction);
  assert.equal(allowed, false);
  assert.match(interaction._replies[0].content, /Owner-only/);
}));

test('requireOwner returns true and never replies for the (injected) owner', withDb(async () => {
  const interaction = fakeInteraction('42');
  interaction.reply = async () => { throw new Error('should not reply when allowed'); };
  const allowed = await requireOwner(interaction, '42');
  assert.equal(allowed, true);
}));

test('logAction records to mod_logs even with no log_channel set', withDb(() => {
  const guild = fakeGuild('1');
  logAction(guild, 'kick', 'Max', 'someone', 'being annoying');
  const logs = db.getLogs('1');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].action, 'kick');
  assert.equal(logs[0].target, 'someone');
  assert.equal(logs[0].reason, 'being annoying');
}));

test('logAction posts an embed when a log_channel is configured and found', withDb(async () => {
  const guild = fakeGuild('1');
  const sent = [];
  guild.channels.cache.set('channel-1', { send: async (payload) => { sent.push(payload); } });
  db.setSetting('1', 'log_channel', 'channel-1');
  await logAction(guild, 'ban', 'Max', 'someone', 'reason here');
  assert.equal(sent.length, 1);
  assert.ok(sent[0].embeds?.length);
}));

test('logAction does nothing extra when the configured channel no longer exists', withDb(async () => {
  const guild = fakeGuild('1');
  db.setSetting('1', 'log_channel', 'missing-channel');
  await assert.doesNotReject(logAction(guild, 'warn', 'Max', 'someone', 'reason'));
  assert.equal(db.getLogs('1').length, 1); // still recorded to the DB
}));
