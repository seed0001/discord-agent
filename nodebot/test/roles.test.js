import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLevel, levelAtLeast, LEVELS } from '../src/web/roles.js';
import { createToken, readToken, verifyToken } from '../src/web/auth.js';

const OWNER = '111';

// -- who gets what -----------------------------------------------------------

test('the instance owner is always creator, whatever the roles say', () => {
  assert.equal(resolveLevel({ userId: OWNER, ownerId: OWNER }), 'creator');
  // Even with roles mapped in a way that would otherwise exclude them.
  assert.equal(resolveLevel({
    userId: OWNER, ownerId: OWNER, adminRoles: ['999'], modRoles: ['888'], roleIds: [],
  }), 'creator');
});

test('a mapped admin role grants admin', () => {
  assert.equal(resolveLevel({
    userId: '222', ownerId: OWNER, roleIds: ['500'], adminRoles: ['500'],
  }), 'admin');
});

test('a mapped mod role grants moderator', () => {
  assert.equal(resolveLevel({
    userId: '222', ownerId: OWNER, roleIds: ['600'], adminRoles: ['500'], modRoles: ['600'],
  }), 'moderator');
});

test('admin beats moderator when someone holds both', () => {
  assert.equal(resolveLevel({
    userId: '222', ownerId: OWNER, roleIds: ['500', '600'],
    adminRoles: ['500'], modRoles: ['600'],
  }), 'admin');
});

test('an unmapped member gets nothing once roles are configured', () => {
  assert.equal(resolveLevel({
    userId: '222', ownerId: OWNER, roleIds: ['777'], adminRoles: ['500'], modRoles: ['600'],
  }), 'none');
});

test('Discord Administrator is admin regardless of mapping', () => {
  // They can already grant themselves any role in the server; pretending
  // otherwise here would be theatre.
  assert.equal(resolveLevel({
    userId: '222', ownerId: OWNER, isAdministrator: true,
    adminRoles: ['500'], modRoles: ['600'], roleIds: [],
  }), 'admin');
});

test('with nothing mapped it falls back to Discord permissions', () => {
  assert.equal(resolveLevel({ userId: '222', ownerId: OWNER, canManageGuild: true }), 'admin');
  assert.equal(resolveLevel({ userId: '222', ownerId: OWNER, canModerate: true }), 'moderator');
  assert.equal(resolveLevel({ userId: '222', ownerId: OWNER }), 'none');
});

test('once roles ARE mapped, permissions stop widening access past Administrator', () => {
  // Someone with Manage Server but no mapped role gets nothing — the mapping
  // is the source of truth from then on.
  assert.equal(resolveLevel({
    userId: '222', ownerId: OWNER, canManageGuild: true, canModerate: true,
    roleIds: ['777'], adminRoles: ['500'],
  }), 'none');
});

test('role ids compare as strings, so numeric snowflakes still match', () => {
  assert.equal(resolveLevel({
    userId: '222', ownerId: OWNER, roleIds: [500], adminRoles: [500],
  }), 'admin');
});

test('an empty owner id does not make everyone the creator', () => {
  assert.equal(resolveLevel({ userId: '', ownerId: '' }), 'none');
  assert.equal(resolveLevel({ userId: '222', ownerId: '' }), 'none');
});

// -- level comparison --------------------------------------------------------

test('levelAtLeast orders creator > admin > moderator > none', () => {
  assert.ok(LEVELS.creator > LEVELS.admin);
  assert.ok(LEVELS.admin > LEVELS.moderator);
  assert.ok(levelAtLeast('creator', 'admin'));
  assert.ok(levelAtLeast('admin', 'admin'));
  assert.ok(!levelAtLeast('moderator', 'admin'));
  assert.ok(!levelAtLeast('none', 'moderator'));
  assert.ok(!levelAtLeast('nonsense', 'moderator'));
});

// -- the token carries the level, and cannot be edited ----------------------

test('a token round-trips its level and user', () => {
  const session = readToken(createToken('moderator', '222'));
  assert.equal(session.level, 'moderator');
  assert.equal(session.userId, '222');
});

test('editing the level in a valid token invalidates it', () => {
  // The whole point of signing the payload rather than just the expiry: a
  // moderator holding a real cookie must not be able to promote themselves.
  const token = createToken('moderator', '222');
  const forged = token.replace('.moderator.', '.creator.');
  assert.notEqual(forged, token);
  assert.equal(readToken(forged), null);
  assert.equal(verifyToken(forged), false);
});

test('editing the user id in a valid token invalidates it', () => {
  const token = createToken('admin', '222');
  assert.equal(readToken(token.replace('.222.', '.111.')), null);
});

test('a token with an unknown or none level is rejected', () => {
  assert.equal(readToken(createToken('none', '222')), null);
  assert.equal(readToken(createToken('superuser', '222')), null);
});

test('garbage and old-format tokens are rejected, not trusted', () => {
  assert.equal(readToken(''), null);
  assert.equal(readToken('nonsense'), null);
  assert.equal(readToken('9999999999.deadbeef'), null); // the pre-levels format
  assert.equal(verifyToken(undefined), false);
});
