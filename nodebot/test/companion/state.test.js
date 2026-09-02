// The relationship pressure model (companion/state.js) is the core of the
// companion system, so this is the most important test file in the
// feature: the maturity-modulated event deltas, time decay, the compact
// context packet format, and the reach_out_drive formula (including the
// "mature relationship, one concerned check-in" exception and the
// resistance spike when that check-in is ignored too).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as db from '../../src/db.js';
import * as stateMod from '../../src/companion/state.js';

function withDb(fn) {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nodebot-companion-test-'));
    db.initDb(path.join(dir, 'test.db'));
    try {
      await fn();
    } finally {
      db.closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function baseState(overrides = {}) {
  return {
    pressures: { ...stateMod.INITIAL_PRESSURES, ...(overrides.pressures || {}) },
    lastInteractionAt: null,
    lastInviteAt: null,
    lastInviteWasConcernCheckin: false,
    consecutiveIgnored: 0,
    sessionsToday: 0,
    invitesToday: 0,
    dailyCountersDate: null,
    updatedAt: 1_000_000,
    ...overrides,
  };
}

// -- the spec's worked example ------------------------------------------

test('two ignored invites early in a relationship mostly drains initiative_confidence, not concern', () => {
  let state = baseState({ pressures: { ...stateMod.INITIAL_PRESSURES, investment: 0.05 } });
  const startingConfidence = state.pressures.initiative_confidence;
  const startingConcern = state.pressures.concern;

  state = stateMod.applyEvent(state, 'voice_invite_ignored', {}, 1_000_000);
  state = stateMod.applyEvent(state, 'voice_invite_ignored', {}, 1_000_000);

  assert.ok(state.pressures.initiative_confidence < startingConfidence - 0.3,
    `expected a big confidence drop, got ${state.pressures.initiative_confidence}`);
  assert.ok(state.pressures.concern - startingConcern < 0.1,
    `expected concern to barely move, got delta ${state.pressures.concern - startingConcern}`);
});

test('the same two ignores after a mature relationship barely touch confidence but raise concern', () => {
  let state = baseState({ pressures: { ...stateMod.INITIAL_PRESSURES, investment: 0.8 } });
  const startingConfidence = state.pressures.initiative_confidence;
  const startingConcern = state.pressures.concern;

  state = stateMod.applyEvent(state, 'voice_invite_ignored', {}, 1_000_000);
  state = stateMod.applyEvent(state, 'voice_invite_ignored', {}, 1_000_000);

  assert.ok(startingConfidence - state.pressures.initiative_confidence < 0.25,
    `expected confidence to barely move, got delta ${startingConfidence - state.pressures.initiative_confidence}`);
  assert.ok(state.pressures.concern > startingConcern + 0.1,
    `expected a real concern rise, got delta ${state.pressures.concern - startingConcern}`);
});

test('voice_invite_accepted raises reciprocity/trust/confidence and relieves concern', () => {
  let state = baseState({ pressures: { ...stateMod.INITIAL_PRESSURES, concern: 0.3 } });
  state = stateMod.applyEvent(state, 'voice_invite_accepted', {}, 1_000_000);
  assert.ok(state.pressures.reciprocity > stateMod.INITIAL_PRESSURES.reciprocity);
  assert.ok(state.pressures.trust > stateMod.INITIAL_PRESSURES.trust);
  assert.ok(state.pressures.initiative_confidence > stateMod.INITIAL_PRESSURES.initiative_confidence);
  assert.ok(state.pressures.concern < 0.3);
});

test('applyEvent does not mutate the input state object', () => {
  const state = baseState();
  const snapshotBefore = JSON.stringify(state.pressures);
  stateMod.applyEvent(state, 'voice_invite_ignored', {}, 1_000_000);
  assert.equal(JSON.stringify(state.pressures), snapshotBefore);
});

// -- time decay -----------------------------------------------------------

test('concern decays toward zero over time', () => {
  const state = baseState({ pressures: { ...stateMod.INITIAL_PRESSURES, concern: 0.8 }, updatedAt: 0 });
  const ticked = stateMod.tick(state, 240 * 3600); // 240 hours later
  assert.ok(ticked.pressures.concern < 0.05, `expected concern to have mostly decayed, got ${ticked.pressures.concern}`);
});

test('investment does NOT decay — it only moves via events', () => {
  const state = baseState({ pressures: { ...stateMod.INITIAL_PRESSURES, investment: 0.6 }, updatedAt: 0 });
  const ticked = stateMod.tick(state, 1000 * 3600);
  assert.equal(ticked.pressures.investment, 0.6);
});

test('tick with zero elapsed time is a no-op', () => {
  const state = baseState({ updatedAt: 5000 });
  const ticked = stateMod.tick(state, 5000);
  assert.deepEqual(ticked.pressures, state.pressures);
});

test('derivedAbsence ramps 0 -> 1 over ABSENCE_RAMP_HOURS and is 0 with no prior conversation', () => {
  const now = 1_000_000;
  assert.equal(stateMod.derivedAbsence(baseState({ lastInteractionAt: null }), now), 0);
  const halfway = baseState({ lastInteractionAt: now - 36 * 3600 }); // half of 72h ramp
  assert.ok(Math.abs(stateMod.derivedAbsence(halfway, now) - 0.5) < 0.01);
  const overdue = baseState({ lastInteractionAt: now - 1000 * 3600 });
  assert.equal(stateMod.derivedAbsence(overdue, now), 1);
});

// -- context packet ---------------------------------------------------------

test('buildContextPacket renders REL/PATTERN/OPEN/STANCE/INTENT in the compact spec format', () => {
  const state = baseState({
    pressures: {
      ...stateMod.INITIAL_PRESSURES, investment: 0.82, reciprocity: 0.74, trust: 0.79, concern: 0.61, frustration: 0.12,
    },
  });
  const { text } = stateMod.buildContextPacket(state, {
    pattern: 'normally responds quickly; missed last 2 invitations',
    threads: [{ title: 'unfinished music idea' }, { title: 'asked about project build' }],
    intentPhrase: 'check in naturally and continue prior thread if appropriate',
  });
  assert.match(text, /^REL: investment=\.82 reciprocity=\.74 trust=\.79 concern=\.61 frustration=\.12$/m);
  assert.match(text, /^PATTERN: normally responds quickly; missed last 2 invitations$/m);
  assert.match(text, /^OPEN: unfinished music idea; asked about project build$/m);
  assert.match(text, /^STANCE: .*$/m);
  assert.match(text, /^INTENT: check in naturally and continue prior thread if appropriate$/m);
});

test('buildContextPacket omits PATTERN/OPEN/INTENT lines when not given', () => {
  const { text } = stateMod.buildContextPacket(baseState());
  assert.doesNotMatch(text, /^PATTERN:/m);
  assert.doesNotMatch(text, /^OPEN:/m);
  assert.doesNotMatch(text, /^INTENT:/m);
  assert.match(text, /^REL: /m);
});

test('the STANCE line includes a caution once concern is elevated', () => {
  const { text } = stateMod.buildContextPacket(baseState({ pressures: { ...stateMod.INITIAL_PRESSURES, concern: 0.5 } }));
  assert.match(text, /don't overreact/);
});

// -- reach_out_drive --------------------------------------------------------

test('low investment + repeated ignores collapses reach_out_drive below threshold', () => {
  let state = baseState({ pressures: { ...stateMod.INITIAL_PRESSURES, investment: 0.05 } });
  state = stateMod.applyEvent(state, 'voice_invite_ignored', {}, 1_000_000);
  state.consecutiveIgnored = 1;
  state = stateMod.applyEvent(state, 'voice_invite_ignored', {}, 1_000_000);
  state.consecutiveIgnored = 2;
  const { drive } = stateMod.computeReachOutDrive(state, 1_000_000);
  assert.ok(drive < stateMod.DRIVE.INITIATE_THRESHOLD, `expected drive below threshold, got ${drive}`);
});

test('a mature relationship with abnormal absence and rising concern produces a concern check-in '
  + 'even with depressed initiative_confidence', () => {
  const state = baseState({
    pressures: {
      ...stateMod.INITIAL_PRESSURES,
      investment: 0.8,
      concern: 0.6,
      initiative_confidence: 0.2, // depressed — below threshold on its own
    },
    lastInteractionAt: 1_000_000 - 200 * 3600, // well past ABNORMAL_ABSENCE
  });
  const result = stateMod.computeReachOutDrive(state, 1_000_000);
  assert.ok(result.concernEligible, 'expected the concern exception to be eligible');
  assert.ok(result.drive >= stateMod.DRIVE.INITIATE_THRESHOLD,
    `expected the concern bonus to push drive over threshold, got ${result.drive}`);
  assert.equal(result.isConcernCheckin, true);
});

test('a concern check-in that gets ignored too triggers the resistance spike and a longer cooldown', () => {
  const ignoredState = baseState({
    pressures: { ...stateMod.INITIAL_PRESSURES, investment: 0.8, concern: 0.6, initiative_confidence: 0.2 },
    lastInviteWasConcernCheckin: true,
    consecutiveIgnored: 1,
  });
  const result = stateMod.computeReachOutDrive(ignoredState, 1_000_000);
  assert.ok(result.ignoreResistance >= stateMod.DRIVE.RESISTANCE_CONCERN_IGNORED_SPIKE,
    `expected the resistance spike to apply, got ${result.ignoreResistance}`);

  const cooldown = stateMod.effectiveCooldownHours(ignoredState, 4);
  assert.ok(cooldown > 4, `expected an extended cooldown, got ${cooldown}`);
  assert.equal(cooldown, 4 * (1 + stateMod.DRIVE.CONCERN_IGNORED_COOLDOWN_MULT));
});

test('effectiveCooldownHours is just the base cooldown outside a concern-check-in-ignored state', () => {
  assert.equal(stateMod.effectiveCooldownHours(baseState(), 4), 4);
});

// -- persistence round-trip (real temp SQLite, same pattern as db.test.js) --

test('load()/save() round-trip through db.js, including the daily counter reset', withDb(() => {
  const guildId = 'g1';
  const userId = 'u1';

  let state = stateMod.load(guildId, userId, 1_700_000_000);
  assert.deepEqual(state.pressures, stateMod.INITIAL_PRESSURES);
  state = { ...state, invitesToday: 1, sessionsToday: 1 };
  stateMod.save(guildId, userId, state, 1_700_000_000);

  const reloadedSameDay = stateMod.load(guildId, userId, 1_700_000_100);
  assert.equal(reloadedSameDay.invitesToday, 1);
  assert.equal(reloadedSameDay.sessionsToday, 1);

  // A guild-local day boundary crossing (default UTC) resets both counters.
  const nextDay = stateMod.load(guildId, userId, 1_700_000_000 + 90000);
  assert.equal(nextDay.invitesToday, 0);
  assert.equal(nextDay.sessionsToday, 0);
}));
