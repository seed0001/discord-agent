// Deterministic tests for the de-escalation gate — a direct port of
// tests/test_deescalation.py, scenario for scenario, so the Node gate is
// provably the same gate. Pure logic: assessments in, decisions out, no I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeAssessment as A, makeState, stateFromDict, decide,
  MIN_STEP_S, SETTLE_S, STAGE_IDLE, STAGE_MODS_NOTIFIED,
} from '../src/deescalation.js';

const why = (d) => d.reasons.join(' ');

// Joking arguments: even with insult counts, banter reads stay silent.
test('a joking argument stays quiet', () => {
  const d = decide(makeState(), A({
    banter: true, targetedInsults: 3, tension: 'rising', harshLanguage: true,
  }));
  assert.equal(d.action, 'none');
  assert.match(why(d), /banter/);
  assert.equal(d.state.stage, STAGE_IDLE);
});

// Passionate disagreement: rising tension without targeting is fine.
test('passionate disagreement stays quiet', () => {
  const d = decide(makeState(), A({ tension: 'rising', participants: 2 }));
  assert.equal(d.action, 'none');
  assert.match(why(d), /not escalation/);
});

// Profanity without targeting: quiet by default...
test('profanity without targeting is quiet by default', () => {
  let state = makeState();
  for (const ts of [0, 60, 120]) {
    const d = decide(state, A({ ts, harshLanguage: true }));
    state = d.state;
    assert.equal(d.action, 'none');
  }
});

// ...but the server preference enables a check-in — and never more.
test('the harsh-language preference can check in but never escalate', () => {
  const d1 = decide(makeState(), A({ ts: 0, harshLanguage: true }), true);
  assert.equal(d1.action, 'none'); // first strike: below threshold
  const d2 = decide(d1.state, A({ ts: 30, harshLanguage: true }), true);
  assert.equal(d2.action, 'check_in');
  assert.match(why(d2), /cannot escalate/);
  assert.equal(d2.state.stage, STAGE_IDLE); // not on the safety ladder
  // Sustained harshness afterward: cooldown holds, never suggests/notifies.
  let state = d2.state;
  for (const ts of [60, 120, 180]) {
    const d = decide(state, A({ ts, harshLanguage: true }), true);
    state = d.state;
    assert.equal(d.action, 'none');
  }
});

// Direct repeated insults climb the full ladder, one restrained step at a time.
test('direct repeated insults climb the ladder one step at a time', () => {
  const hostile = { targetedInsults: 2, insultRepeat: true, tension: 'rising' };
  const d1 = decide(makeState(), A({ ts: 0, ...hostile }));
  assert.equal(d1.action, 'check_in');
  const d2 = decide(d1.state, A({ ts: MIN_STEP_S + 5, ...hostile }));
  assert.equal(d2.action, 'suggest_pause');
  const d3 = decide(d2.state, A({ ts: 2 * MIN_STEP_S + 10, ...hostile }));
  assert.equal(d3.action, 'notify_mods');
  // After mods: Max stays out of it.
  const d4 = decide(d3.state, A({ ts: 3 * MIN_STEP_S, ...hostile }));
  assert.equal(d4.action, 'none');
  assert.match(why(d4), /humans own it/);
});

// Cooldown: a second hostile read 30s after a check-in holds (no spam).
test('a cooldown holds between ladder steps', () => {
  const hostile = { targetedInsults: 2, tension: 'rising' };
  const d1 = decide(makeState(), A({ ts: 0, ...hostile }));
  assert.equal(d1.action, 'check_in');
  const d2 = decide(d1.state, A({ ts: 30, ...hostile }));
  assert.equal(d2.action, 'none');
  assert.match(why(d2), /holding/);
});

// Ignored stop requests count as serious on their own.
test('an ignored request to stop is serious on its own', () => {
  const d = decide(makeState(), A({ ts: 0, stopIgnored: true }));
  assert.equal(d.action, 'check_in');
  assert.match(why(d), /stop/);
});

// Credible threats skip the ladder and go straight to the moderators.
test('a credible threat fast-tracks to the moderators', () => {
  const d = decide(makeState(), A({ ts: 0, credibleThreat: true }));
  assert.equal(d.action, 'notify_mods');
  assert.equal(d.state.stage, STAGE_MODS_NOTIFIED);
  // Even inside a cooldown window.
  const d2 = decide(
    makeState({ stage: 0, lastActionTs: 0, confirmations: 1, lastSeriousTs: 0 }),
    A({ ts: 10, credibleThreat: true }),
  );
  assert.equal(d2.action, 'notify_mods');
});

// Cross-talk needs to be sustained (two reads), not a one-off.
test('cross-talk must be sustained before it counts', () => {
  const d1 = decide(makeState(), A({ ts: 0, crossTalk: true }));
  assert.equal(d1.action, 'none');
  const d2 = decide(
    makeState({ confirmations: 1, stage: STAGE_IDLE, lastSeriousTs: 0 }),
    A({ ts: 30, crossTalk: true }),
  );
  assert.equal(d2.action, 'check_in');
});

// Resolved conflicts settle: falling tension resets the ladder.
test('a resolved conflict disengages and resets', () => {
  const hostile = { targetedInsults: 2, tension: 'rising' };
  const d1 = decide(makeState(), A({ ts: 0, ...hostile }));
  assert.equal(d1.action, 'check_in');
  const d2 = decide(d1.state, A({ ts: 120, tension: 'falling' }));
  assert.equal(d2.action, 'none');
  assert.equal(d2.settled, true);
  assert.equal(d2.state.stage, STAGE_IDLE);
  // A fresh flare-up starts from the bottom of the ladder again.
  const d3 = decide(d2.state, A({ ts: 200, ...hostile }));
  assert.equal(d3.action, 'check_in');
});

// Quiet long enough also settles, even at "steady".
test('a long quiet period settles the conflict', () => {
  const state = makeState({ stage: 0, lastActionTs: 0, lastSeriousTs: 0, confirmations: 1 });
  const d = decide(state, A({ ts: SETTLE_S + 1, tension: 'steady' }));
  assert.equal(d.settled, true);
});

// Restart safety: state round-trips through its serialized form.
test('state survives a round-trip through storage', () => {
  const hostile = { targetedInsults: 2, tension: 'rising' };
  const d1 = decide(makeState(), A({ ts: 0, ...hostile }));
  const revived = stateFromDict(JSON.parse(JSON.stringify(d1.state)));
  assert.deepEqual(revived, d1.state);
  const d2 = decide(revived, A({ ts: MIN_STEP_S + 5, ...hostile }));
  assert.equal(d2.action, 'suggest_pause'); // ladder position survived
});

// The gate must not mutate the caller's state object in place.
test('decide does not mutate the state it was given', () => {
  const original = makeState();
  const snapshot = { ...original };
  decide(original, A({ ts: 0, targetedInsults: 2, tension: 'rising' }));
  assert.deepEqual(original, snapshot);
});

// Punishment is not on the ladder, at any stage, ever.
test('no decision path ever produces a punitive action', () => {
  const hostile = { targetedInsults: 3, insultRepeat: true, tension: 'rising', credibleThreat: true };
  let state = makeState();
  const seen = new Set();
  for (let i = 0; i < 12; i += 1) {
    const d = decide(state, A({ ts: i * (MIN_STEP_S + 1), ...hostile }));
    state = d.state;
    seen.add(d.action);
  }
  for (const action of seen) {
    assert.ok(['none', 'check_in', 'suggest_pause', 'notify_mods'].includes(action),
      `unexpected action from the gate: ${action}`);
  }
});
