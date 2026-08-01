import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as db from '../src/db.js';
import { handleMemberAdd, handleMemberRemove } from '../src/welcome.js';
import { formatTemplate } from '../src/utils.js';

function withDb(fn) {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nodebot-welcome-test-'));
    db.initDb(path.join(dir, 'test.db'));
    try {
      await fn();
    } finally {
      db.closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('formatTemplate fills user/server/membercount', () => {
  const guild = { name: 'Test Guild', memberCount: 12 };
  const member = { toString: () => '<@42>', guild };
  const result = formatTemplate('Welcome {user} to {server}! #{membercount}', member);
  assert.equal(result, 'Welcome <@42> to Test Guild! #12');
});

test('handleMemberAdd does nothing when nothing is configured', withDb(async () => {
  const guild = { id: '1', name: 'G', memberCount: 1, roles: { cache: new Map() }, channels: { cache: new Map() } };
  await handleMemberAdd({ id: '42', guild, toString: () => '<@42>', roles: { add: async () => {} } });
  // no throw, nothing to assert further
}));

test('handleMemberAdd applies the autorole when configured and the role exists', withDb(async () => {
  const guild = { id: '1', name: 'G', memberCount: 1, roles: { cache: new Map([['role-1', { id: 'role-1' }]]) }, channels: { cache: new Map() } };
  db.setSetting('1', 'autorole', 'role-1');
  let added = null;
  const member = { id: '42', guild, toString: () => '<@42>', roles: { add: async (role) => { added = role; } } };
  await handleMemberAdd(member);
  assert.deepEqual(added, { id: 'role-1' });
}));

test('handleMemberAdd sends the welcome message to the configured channel', withDb(async () => {
  const sent = [];
  const channel = { send: async (text) => { sent.push(text); } };
  const guild = {
    id: '1', name: 'Test Guild', memberCount: 5,
    roles: { cache: new Map() }, channels: { cache: new Map([['chan-1', channel]]) },
  };
  db.setSetting('1', 'welcome_channel', 'chan-1');
  db.setSetting('1', 'welcome_message', 'Welcome {user} to {server}, member #{membercount}!');
  const member = { id: '42', guild, toString: () => '<@42>', roles: { add: async () => {} } };
  await handleMemberAdd(member);
  assert.deepEqual(sent, ['Welcome <@42> to Test Guild, member #5!']);
}));

test('handleMemberRemove sends the goodbye message', withDb(async () => {
  const sent = [];
  const channel = { send: async (text) => { sent.push(text); } };
  const guild = { id: '1', name: 'Test Guild', memberCount: 4, channels: { cache: new Map([['chan-1', channel]]) } };
  db.setSetting('1', 'welcome_channel', 'chan-1');
  db.setSetting('1', 'goodbye_message', '{user} has left {server}.');
  const member = { id: '42', guild, toString: () => '<@42>' };
  await handleMemberRemove(member);
  assert.deepEqual(sent, ['<@42> has left Test Guild.']);
}));

test('handleMemberRemove does nothing without a configured channel', withDb(async () => {
  const guild = { id: '1', name: 'Test Guild', memberCount: 4, channels: { cache: new Map() } };
  const member = { id: '42', guild, toString: () => '<@42>' };
  await handleMemberRemove(member); // must not throw
}));
