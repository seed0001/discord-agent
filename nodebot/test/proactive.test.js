// proactive.js / deescalate.js — the deterministic parts. The classify and
// draft steps are model calls; what's testable without a model is the JSON
// tolerance and the validation that stands between a model's output and the
// gates, which is exactly where a bad parse would do damage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJson } from '../src/proactive.js';
import { parseAssessment } from '../src/deescalate.js';

// -- tolerant JSON ------------------------------------------------------------

test('parses a bare JSON object', () => {
  assert.deepEqual(parseJson('{"topic":"deploy","signals":[]}'), { topic: 'deploy', signals: [] });
});

test('parses JSON wrapped in a code fence', () => {
  assert.deepEqual(parseJson('```json\n{"topic":"deploy"}\n```'), { topic: 'deploy' });
});

test('parses JSON padded with prose', () => {
  assert.deepEqual(parseJson('Sure thing! {"topic":"deploy"} hope that helps'), { topic: 'deploy' });
});

test('returns null rather than throwing on unparseable output', () => {
  assert.equal(parseJson('no json here'), null);
  assert.equal(parseJson('{"broken": '), null);
  assert.equal(parseJson(''), null);
  assert.equal(parseJson(null), null);
});

// -- assessment validation ----------------------------------------------------

test('a full assessment round-trips into the gate structure', () => {
  const a = parseAssessment(JSON.stringify({
    tension: 'rising',
    participants: 3,
    targeted_insults: 2,
    insult_repeat: true,
    credible_threat: false,
    stop_ignored: true,
    cross_talk: false,
    banter: false,
    harsh_language: true,
    summary: 'two people going at it',
  }), 100);
  assert.equal(a.ts, 100);
  assert.equal(a.tension, 'rising');
  assert.equal(a.participants, 3);
  assert.equal(a.targetedInsults, 2);
  assert.equal(a.insultRepeat, true);
  assert.equal(a.stopIgnored, true);
  assert.equal(a.harshLanguage, true);
  assert.equal(a.summary, 'two people going at it');
});

test('an unrecognized tension value falls back to steady', () => {
  // A model returning "spicy" must not become a truthy escalation input.
  assert.equal(parseAssessment('{"tension":"spicy"}', 0).tension, 'steady');
  assert.equal(parseAssessment('{}', 0).tension, 'steady');
});

test('missing or junk numeric fields degrade to safe values', () => {
  const a = parseAssessment('{"participants":"lots","targeted_insults":"many"}', 0);
  assert.equal(a.participants, 2);   // default, not NaN
  assert.equal(a.targetedInsults, 0); // default, not NaN
});

test('a negative insult count cannot be used to game the gate', () => {
  assert.equal(parseAssessment('{"targeted_insults":-5}', 0).targetedInsults, 0);
});

test('an overlong summary is truncated', () => {
  const a = parseAssessment(JSON.stringify({ summary: 'x'.repeat(500) }), 0);
  assert.equal(a.summary.length, 200);
});

test('unparseable assessment output yields null, leaving the ladder untouched', () => {
  assert.equal(parseAssessment('the vibes are off', 0), null);
  assert.equal(parseAssessment('', 0), null);
});
