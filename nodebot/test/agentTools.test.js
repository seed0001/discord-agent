// Fakes use real discord.js Collections (find/filter/map work correctly
// for free) wrapping plain objects with just the methods each handler
// actually calls — not full discord.js Guild/Member/Channel instances,
// which would need a live gateway connection to construct properly.
//
// execute()'s ownerId param is an injectable override (mirrors isOwner/
// requireOwner elsewhere) — every "this should succeed" call below passes
// OWNER so the owner-check doesn't block it regardless of the real
// (unset) OWNER_ID in this environment; the deny-path tests rely on that
// unset default instead, same assumption utils.test.js already makes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Collection, ChannelType } from 'discord.js';
import * as db from '../src/db.js';
import * as agentTools from '../src/agentTools.js';

const OWNER = 'owner-1';

function withDb(fn) {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nodebot-agenttools-test-'));
    db.initDb(path.join(dir, 'test.db'));
    try {
      await fn();
    } finally {
      db.closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function fakeMember(id, { username, bot = false, roles = [] } = {}) {
  const sent = [];
  const member = {
    id,
    user: { id, username: username || `user${id}`, tag: `${username || `user${id}`}#0`, bot },
    displayName: username || `user${id}`,
    roles: { cache: new Collection(roles.map((r) => [r.id, r])), add: async () => {}, remove: async () => {} },
    joinedTimestamp: 1700000000000,
    isCommunicationDisabled: () => false,
    kick: async () => { member._kicked = true; },
    ban: async () => { member._banned = true; },
    timeout: async (ms) => { member._timeoutMs = ms; },
    send: async (msg) => { sent.push(msg); },
    _sent: sent,
  };
  return member;
}

function fakeGuild(id) {
  const members = new Collection();
  const roles = new Collection();
  const channels = new Collection();
  return {
    id,
    name: `Guild ${id}`,
    memberCount: 1,
    premiumTier: 0,
    members: { cache: members, me: null, fetch: async () => { throw new Error('not found'); } },
    roles: {
      cache: roles,
      everyone: { id },
      create: async ({ name, color }) => {
        const role = { id: `role-${name}`, name, color, members: new Collection() };
        roles.set(role.id, role);
        return role;
      },
    },
    channels: {
      cache: channels,
      create: async ({ name, type, parent }) => {
        const channel = { id: `chan-${name}`, name, type, parent };
        channels.set(channel.id, channel);
        return channel;
      },
    },
    bans: { remove: async () => {} },
    fetchOwner: async () => ({ user: { tag: 'owner#0' } }),
  };
}

function fakeMessage(guild, channel, authorId = OWNER) {
  return { guild, channel, author: { id: authorId, tag: 'owner#0', username: 'owner' } };
}

test('resolveMember matches by exact display name and reports a clear error otherwise', withDb(async () => {
  const guild = fakeGuild('1');
  const alice = fakeMember('42', { username: 'alice' });
  guild.members.cache.set('42', alice);
  guild.members.me = fakeMember('bot-id', { username: 'Max' });
  const message = fakeMessage(guild, { name: 'general' });

  const result = await agentTools.execute(null, message, 'member_info', { user: 'alice' }, OWNER);
  assert.match(result, /alice/);

  const missing = await agentTools.execute(null, message, 'member_info', { user: 'nobody' }, OWNER);
  assert.match(missing, /No member found/);
}));

test('kick_member refuses to target the bot itself', withDb(async () => {
  const guild = fakeGuild('1');
  const botMember = fakeMember('bot-id', { username: 'Max' });
  guild.members.cache.set('bot-id', botMember);
  guild.members.me = botMember;
  const message = fakeMessage(guild, { name: 'general' });

  const result = await agentTools.execute(null, message, 'kick_member', { user: 'Max' }, OWNER);
  assert.match(result, /won't take moderation actions against myself/);
}));

test('kick_member kicks and logs the action', withDb(async () => {
  const guild = fakeGuild('1');
  const botMember = fakeMember('bot-id', { username: 'Max' });
  guild.members.cache.set('bot-id', botMember);
  guild.members.me = botMember;
  const alice = fakeMember('42', { username: 'alice' });
  guild.members.cache.set('42', alice);
  const message = fakeMessage(guild, { name: 'general' });

  const result = await agentTools.execute(null, message, 'kick_member', { user: 'alice', reason: 'spam' }, OWNER);
  assert.match(result, /Kicked/);
  assert.equal(alice._kicked, true);
  assert.equal(db.getLogs('1').length, 1);
  assert.equal(db.getLogs('1')[0].action, 'kick');
}));

test('warn_member records a warning and reports the running count', withDb(async () => {
  const guild = fakeGuild('1');
  guild.members.me = fakeMember('bot-id', { username: 'Max' });
  const alice = fakeMember('42', { username: 'alice' });
  guild.members.cache.set('42', alice);
  const message = fakeMessage(guild, { name: 'general' });

  const first = await agentTools.execute(null, message, 'warn_member', { user: 'alice', reason: 'first' }, OWNER);
  assert.match(first, /warning #1/);
  const second = await agentTools.execute(null, message, 'warn_member', { user: 'alice', reason: 'second' }, OWNER);
  assert.match(second, /warning #2/);
  assert.equal(alice._sent.length, 2); // DMed both times
}));

test('create_channel and create_role actually create and log', withDb(async () => {
  const guild = fakeGuild('1');
  guild.members.me = fakeMember('bot-id', { username: 'Max' });
  const message = fakeMessage(guild, { name: 'general' });

  const channelResult = await agentTools.execute(
    null, message, 'create_channel', { name: 'new-room', kind: 'voice' }, OWNER,
  );
  assert.match(channelResult, /Created voice channel #new-room/);
  assert.equal(guild.channels.cache.get('chan-new-room').type, ChannelType.GuildVoice);

  const roleResult = await agentTools.execute(
    null, message, 'create_role', { name: 'Helper', color: '#5865F2' }, OWNER,
  );
  assert.match(roleResult, /Created role Helper/);
  assert.equal(db.getLogs('1').filter((l) => l.action === 'role_create').length, 1);
}));

test('create_role rejects an invalid hex color', withDb(async () => {
  const guild = fakeGuild('1');
  guild.members.me = fakeMember('bot-id', { username: 'Max' });
  const message = fakeMessage(guild, { name: 'general' });
  const result = await agentTools.execute(null, message, 'create_role', { name: 'Bad', color: 'not-a-color' }, OWNER);
  assert.match(result, /Invalid hex color/);
}));

test('unban_user rejects a non-numeric id without touching the guild', withDb(async () => {
  const guild = fakeGuild('1');
  guild.members.me = fakeMember('bot-id', { username: 'Max' });
  const message = fakeMessage(guild, { name: 'general' });
  const result = await agentTools.execute(null, message, 'unban_user', { user_id: 'not-an-id' }, OWNER);
  assert.match(result, /numeric Discord user ID/);
}));

test('execute rejects a non-owner regardless of tool', withDb(async () => {
  const guild = fakeGuild('1');
  const message = fakeMessage(guild, { name: 'general' }, 'someone-else');
  const result = await agentTools.execute(null, message, 'server_info', {}, OWNER);
  assert.match(result, /only the bot owner/);
}));

test('execute reports an unknown tool name plainly, for the owner', withDb(async () => {
  const guild = fakeGuild('1');
  const message = fakeMessage(guild, { name: 'general' });
  const result = await agentTools.execute(null, message, 'not_a_real_tool', {}, OWNER);
  assert.match(result, /unknown tool/);
}));

test('TOOL_SCHEMAS has one schema per tool, all well-formed function schemas', () => {
  const names = Object.keys(agentTools.TOOLS);
  assert.equal(agentTools.TOOL_SCHEMAS.length, names.length);
  for (const s of agentTools.TOOL_SCHEMAS) {
    assert.equal(s.type, 'function');
    assert.ok(s.function.name);
    assert.ok(s.function.description);
    assert.equal(s.function.parameters.type, 'object');
  }
});
