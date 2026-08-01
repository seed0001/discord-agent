// Deterministic tests for the pressure engine — a direct port of
// pressure/tests/test_engine.py. Injected clock, no network, no LLM, so the
// Node engine is provably the same engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  PressureEngine, SqliteStore, makeSignal, makeProposal, heuristicRelevance,
} from '../src/pressure/index.js';

const sig = (key, source, topic, confidence = 0.9, ts = 0, extra = {}) => makeSignal({
  key, source, weight: 0, confidence, ts, topic, channel_id: 'chan1', ...extra,
});

const proposal = (topic, bucket, contentKey = null, extra = {}) => makeProposal({
  topic,
  bucket,
  contentKey: contentKey || `${topic}-point`,
  summary: `say something about ${topic}`,
  channelId: 'chan1',
  ...extra,
});

function speakIfAllowed(engine, p, now) {
  const d = engine.evaluate(p, now);
  if (d.allowed) engine.recordSpoken(p, now);
  return d;
}

// 1. High-value unresolved blocker causes exactly one useful contribution.
test('a real blocker produces exactly one contribution', () => {
  const engine = new PressureEngine();
  engine.observeMessage(0, 'chan1', 'travis', false, 'deploy');
  engine.ingest(sig('b1', 'unresolved_blocker', 'deploy', 0.9, 0), 0);
  engine.ingest(sig('b2', 'stalled_progress', 'deploy', 0.8, 5), 5);
  engine.tick(10);
  const d = speakIfAllowed(engine, proposal('deploy', 'assist'), 10);
  assert.ok(d.allowed, d.reasons.join('; '));
  assert.equal(engine.store.contributions().length, 1);
  // Immediately after: discharged + cooled down, cannot speak again.
  const d2 = speakIfAllowed(engine, proposal('deploy', 'assist', 'another-point'), 15);
  assert.equal(d2.allowed, false);
  assert.equal(engine.store.contributions().length, 1);
});

// 2. Weak signals decay without Max speaking.
test('weak signals decay silently', () => {
  const engine = new PressureEngine();
  engine.observeMessage(0, 'chan1', 'travis', false, 'game');
  engine.ingest(sig('w1', 'topic_relevance', 'game', 0.5, 0), 0);
  for (let t = 0; t < 4000; t += 200) {
    engine.tick(t);
    const d = engine.evaluate(proposal('game', 'social'), t);
    assert.equal(d.allowed, false, `spoke at t=${t}: ${d.reasons.join('; ')}`);
  }
  engine.tick(4000);
  assert.ok(engine.store.getPressures().social < 0.01);
  assert.equal(engine.store.contributions().length, 0);
});

// 3. Repeated signals do not produce repeated messages.
test('repeated signals do not produce repeated messages', () => {
  const engine = new PressureEngine();
  engine.observeMessage(0, 'chan1', 'travis', false, 'deploy');
  // Identical idempotency key replayed — charges once.
  for (let t = 0; t < 50; t += 10) {
    engine.ingest(sig('same-key', 'unresolved_blocker', 'deploy', 0.9, t), t);
  }
  engine.ingest(sig('other', 'stalled_progress', 'deploy', 0.8, 45), 45);
  engine.tick(50);
  speakIfAllowed(engine, proposal('deploy', 'assist', 'fix-a'), 50);
  const n = engine.store.contributions().length;
  assert.equal(n, 1);
  // Fresh keys, same topic, right after speaking — refractory + cooldowns hold.
  for (let t = 60; t < 400; t += 20) {
    engine.ingest(sig(`k${t}`, 'unresolved_blocker', 'deploy', 0.9, t), t);
    engine.tick(t);
    speakIfAllowed(engine, proposal('deploy', 'assist', 'fix-a'), t);
  }
  assert.equal(engine.store.contributions().length, n);
});

// 4. Topic changes decay/abandon pressure without speaking.
test('a topic change abandons its pressure without speaking', () => {
  const engine = new PressureEngine();
  engine.observeMessage(0, 'chan1', 'travis', false, 'deploy');
  engine.ingest(sig('b1', 'unresolved_blocker', 'deploy', 0.9, 0), 0);
  // The conversation moves on; deploy is never mentioned again.
  engine.observeMessage(30, 'chan1', 'travis', false, 'game');
  engine.tick(700); // past topicAbandonAfter from deploy's last mention
  const states = Object.fromEntries(engine.store.signals(null).map((s) => [s.key, s.state]));
  assert.equal(states.b1, 'abandoned');
  const d = engine.evaluate(proposal('deploy', 'assist'), 700);
  assert.equal(d.allowed, false);
  assert.equal(engine.store.contributions().length, 0);
});

// Someone else solving it discharges without speaking.
test('someone else solving it discharges the pressure', () => {
  const engine = new PressureEngine();
  engine.observeMessage(0, 'chan1', 'travis', false, 'deploy');
  engine.ingest(sig('b1', 'unresolved_blocker', 'deploy', 0.9, 0), 0);
  engine.tick(10);
  const before = engine.store.getPressures().assist;
  engine.resolve(20, 'satisfied', { topic: 'deploy' });
  const after = engine.store.getPressures().assist;
  assert.ok(after < before);
  const d = engine.evaluate(proposal('deploy', 'assist'), 25);
  assert.equal(d.allowed, false);
  assert.match(d.reasons.join(' '), /topic is satisfied/);
});

// Active exchange holds Max back; urgent moderation bypasses the hold.
test('an active exchange holds Max back, but urgent moderation passes', () => {
  const engine = new PressureEngine();
  for (const [t, author] of [[0, 'a'], [5, 'b'], [8, 'a'], [12, 'b']]) {
    engine.observeMessage(t, 'chan1', author, false, 'argument');
  }
  engine.ingest(sig('s1', 'safety_concern', 'argument', 0.95, 12), 12);
  engine.tick(13);
  const held = engine.evaluate(proposal('argument', 'moderate', null, { urgent: false }), 13);
  assert.equal(held.allowed, false);
  assert.ok(held.reasons.includes('active exchange in progress'));
  const allowed = engine.evaluate(
    proposal('argument', 'moderate', 'mod-1', { urgent: true }), 13,
  );
  assert.ok(allowed.allowed, allowed.reasons.join('; '));
});

// Own messages never create pressure or exchange state.
test("Max's own messages never create pressure or exchange state", () => {
  const engine = new PressureEngine();
  for (let t = 0; t < 40; t += 5) {
    engine.observeMessage(t, 'chan1', 'max', true, 'anything');
  }
  assert.equal(engine.exchangeActive(40, 'chan1'), false);
  assert.deepEqual(engine.store.kvGet('msg_times:chan1', []), []);
});

// Pressure is capped: cannot grow forever.
test('pressure is capped and the signal queue stays bounded', () => {
  const engine = new PressureEngine();
  for (let i = 0; i < 500; i += 1) {
    engine.ingest(sig(`k${i}`, 'unresolved_blocker', 'deploy', 1.0, 0), 0);
  }
  const cap = engine.config.buckets.assist.cap;
  assert.ok(engine.store.getPressures().assist <= cap);
  assert.ok(engine.store.signals('active').length <= engine.config.maxActiveSignals);
});

// Same point is never made twice, even after cooldowns lapse.
test('the same point is never made twice, even long after cooldowns lapse', () => {
  const engine = new PressureEngine();
  engine.observeMessage(0, 'chan1', 'travis', false, 'deploy');
  engine.ingest(sig('b1', 'unresolved_blocker', 'deploy', 0.9, 0), 0);
  engine.ingest(sig('b2', 'stalled_progress', 'deploy', 0.8, 5), 5);
  engine.tick(10);
  const d0 = speakIfAllowed(engine, proposal('deploy', 'assist', 'pin-libopus'), 10);
  assert.ok(d0.allowed, d0.reasons.join('; '));
  // Long after all cooldowns expire: new signal, same point.
  const t = 3000;
  engine.observeMessage(t, 'chan1', 'travis', false, 'deploy');
  engine.ingest(sig('b9', 'unresolved_blocker', 'deploy', 0.9, t), t);
  engine.tick(t + 10);
  const d = engine.evaluate(proposal('deploy', 'assist', 'pin-libopus'), t + 10);
  assert.equal(d.allowed, false);
  assert.ok(d.reasons.some((r) => r.includes('same point already made')));
});

// Gate limits questions per contribution.
test('the gate limits questions per contribution', () => {
  const engine = new PressureEngine();
  engine.observeMessage(0, 'chan1', 'travis', false, 'deploy');
  engine.ingest(sig('b1', 'unresolved_blocker', 'deploy', 0.9, 0), 0);
  engine.tick(10);
  const d = engine.evaluate(proposal('deploy', 'assist', null, { questionCount: 3 }), 10);
  assert.equal(d.allowed, false);
  assert.ok(d.reasons.some((r) => r.includes('questions exceeds')));
});

// Every evaluation is logged, allowed or not.
test('every decision is audited, pass or fail', () => {
  const engine = new PressureEngine();
  engine.evaluate(proposal('nothing', 'assist'), 0);
  const decisions = engine.store.decisions();
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].allowed, false);
  assert.ok(decisions[0].reasons.length);
  assert.ok('assist' in decisions[0].pressures);
});

// Persistence: full engine state survives a restart.
test('engine state survives a restart', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nodebot-pressure-'));
  const dbPath = path.join(dir, 'pressure.db');
  try {
    const engine = new PressureEngine(new SqliteStore(dbPath));
    engine.observeMessage(0, 'chan1', 'travis', false, 'deploy');
    engine.ingest(sig('b1', 'unresolved_blocker', 'deploy', 0.9, 0), 0);
    engine.tick(10);
    engine.recordSpoken(makeProposal({
      topic: 'deploy', bucket: 'assist', contentKey: 'p1', summary: 's', channelId: 'chan1',
    }), 10);
    const pressures = engine.store.getPressures();
    engine.store.close();

    // "restart"
    const engine2 = new PressureEngine(new SqliteStore(dbPath));
    assert.deepEqual(engine2.store.getPressures(), pressures);
    assert.equal(engine2.store.contributions().length, 1);
    assert.ok(engine2.cooldowns.active(11, 'chan1', '', 'deploy').length);
    const states = Object.fromEntries(engine2.store.signals(null).map((s) => [s.key, s.state]));
    assert.equal(states.b1, 'spoken');
    engine2.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- additions beyond the Python set ----------------------------------------

test('a topic containing spaces survives the candidate ranking', () => {
  // candidates() keys by bucket+topic; a naive join/split would truncate
  // "tabs vs spaces" to "tabs".
  const engine = new PressureEngine();
  engine.observeMessage(0, 'chan1', 'travis', false, 'tabs vs spaces');
  engine.ingest(sig('c1', 'incorrect_claim', 'tabs vs spaces', 0.9, 0), 0);
  const candidates = engine.candidates(1);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].topic, 'tabs vs spaces');
  assert.equal(candidates[0].bucket, 'correct');
});

test('an unknown signal source is rejected rather than routed anywhere', () => {
  const engine = new PressureEngine();
  assert.equal(engine.ingest(sig('x', 'not_a_real_source', 'deploy', 0.9, 0), 0), false);
  assert.equal(engine.store.signals('active').length, 0);
});

test('a signal below the confidence floor never charges', () => {
  const engine = new PressureEngine();
  assert.equal(engine.ingest(sig('x', 'unresolved_blocker', 'deploy', 0.1, 0), 0), false);
  assert.equal(engine.store.getPressures().assist, 0);
});

test('heuristic relevance scores exact, partial, and absent topics', () => {
  assert.equal(heuristicRelevance('deploy', 'deploy'), 1.0);
  assert.equal(heuristicRelevance('deploy', ''), 0.5);
  assert.equal(heuristicRelevance('deploy', 'game'), 0);
  assert.ok(heuristicRelevance('deploy-fix', 'deploy') > 0);
});
