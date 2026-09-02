// Session lifecycle needs a real Discord guild/voice connection for most of
// its behavior (beginWaiting/handleUserJoined/closeSession/
// handleVoiceStateUpdate all call into voice.js), which this codebase's test
// suite does not otherwise mock — so this file covers what's genuinely
// unit-testable: the idle/status bookkeeping, and recordDeliberateContact's
// guard conditions and db effects (the reciprocity signal wiring from
// textChat.js/voice.js/the DM handler all funnel through it). The full
// invite -> wait -> join -> conversation -> close lifecycle is covered by
// manual verification (see the plan's Verification section).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as db from '../../src/db.js';
import * as session from '../../src/companion/session.js';
import * as events from '../../src/companion/events.js';
import * as stateMod from '../../src/companion/state.js';

function withDb(fn) {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nodebot-companion-test-'));
    db.initDb(path.join(dir, 'test.db'));
    session._resetForTests();
    try {
      await fn();
    } finally {
      db.closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('a fresh guild has no session — status idle, get null', () => {
  session._resetForTests();
  assert.equal(session.status('g-never-seen'), 'idle');
  assert.equal(session.get('g-never-seen'), null);
  assert.equal(session.isIdle('g-never-seen'), true);
});

test('recordDeliberateContact is a no-op when companion mode is off', withDb(() => {
  db.setSetting('g1', 'companion_primary_user_id', 'u1');
  // companion_enabled left at its default (false)
  session.recordDeliberateContact('g1', 'u1', 'mention');
  assert.equal(events.recent('g1', 'u1').length, 0);
}));

test('recordDeliberateContact is a no-op for anyone other than the primary user', withDb(() => {
  db.setSetting('g1', 'companion_enabled', true);
  db.setSetting('g1', 'companion_primary_user_id', 'u1');
  session.recordDeliberateContact('g1', 'someone-else', 'mention');
  assert.equal(events.recent('g1', 'someone-else').length, 0);
  assert.equal(events.recent('g1', 'u1').length, 0);
}));

test('recordDeliberateContact logs the event and softens initiative_confidence for the primary user', withDb(() => {
  db.setSetting('g1', 'companion_enabled', true);
  db.setSetting('g1', 'companion_primary_user_id', 'u1');

  // No fixed historical timestamp here on purpose: recordDeliberateContact
  // loads/saves using the real clock internally, and mixing that with an
  // old fixed timestamp would let tick()'s decay (toward its own baseline)
  // swamp the +0.05 event bump this test is actually checking for.
  let state = stateMod.load('g1', 'u1');
  state = { ...state, pressures: { ...state.pressures, initiative_confidence: 0.1 } };
  stateMod.save('g1', 'u1', state);

  session.recordDeliberateContact('g1', 'u1', 'mention');

  const recorded = events.recent('g1', 'u1');
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].type, 'user_initiated_contact');
  assert.equal(recorded[0].data.reason, 'mention');

  const after = stateMod.load('g1', 'u1');
  assert.ok(after.pressures.initiative_confidence > 0.1, 'expected reciprocity to soften initiative_confidence upward');
}));
