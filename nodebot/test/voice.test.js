import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchesAny, describeToolCalls, isPass,
  isFollowUpOpen, openFollowUp, closeFollowUp, _resetForTests,
} from '../src/voice.js';
import { normalizePhrase } from '../src/phrases.js';
import {
  VOICE_STOP_SPEAKING_WORDS, VOICE_STOP_LISTENING_WORDS,
} from '../src/config.js';

function toolCall(name, args) {
  return { function: { name, arguments: JSON.stringify(args) } };
}

test('matches a wake word inside a longer sentence', () => {
  assert.equal(matchesAny('hey max what do you think', ['hey max', 'hey andrew']), true);
});

test('is case-insensitive', () => {
  assert.equal(matchesAny('HEY MAX are you there', ['hey max']), true);
});

test('ignores punctuation between words', () => {
  assert.equal(matchesAny('hey, max! you around?', ['hey max']), true);
});

test('does not match when no phrase is present', () => {
  assert.equal(matchesAny('just chatting about lunch', ['hey max', 'hey andrew']), false);
});

test('empty word list never matches', () => {
  assert.equal(matchesAny('hey max', []), false);
});

test('describeToolCalls produces a known blurb for a recognized tool', () => {
  const blurb = describeToolCalls([toolCall('kick_member', { user: 'alice' })]);
  assert.equal(blurb, 'on it — kicking alice.');
});

test('describeToolCalls joins multiple calls with "then"', () => {
  const blurb = describeToolCalls([
    toolCall('kick_member', { user: 'alice' }),
    toolCall('send_message', { channel: 'general' }),
  ]);
  assert.equal(blurb, 'on it — kicking alice, then posting that in #general.');
});

test('describeToolCalls falls back to "handling that" for an unrecognized tool', () => {
  const blurb = describeToolCalls([toolCall('some_future_tool', {})]);
  assert.equal(blurb, 'on it — handling that.');
});

test('describeToolCalls survives malformed argument JSON from the model', () => {
  const blurb = describeToolCalls([{ function: { name: 'kick_member', arguments: 'not json' } }]);
  assert.equal(blurb, 'on it — kicking undefined.');
});

test('describeToolCalls with no calls at all', () => {
  assert.equal(describeToolCalls([]), 'on it, one sec.');
});

// -- follow-up mode: the "keep listening" window ------------------------------

test('a channel with no window open needs the wake word', () => {
  _resetForTests();
  assert.equal(isFollowUpOpen('chan-1'), false);
});

test('an opened window is live until it lapses, then is not', () => {
  _resetForTests();
  const t0 = 1_000_000;
  openFollowUp('chan-1', 25, t0);
  assert.equal(isFollowUpOpen('chan-1', t0 + 24_000), true);
  assert.equal(isFollowUpOpen('chan-1', t0 + 25_001), false);
});

test('a window does not leak across channels', () => {
  _resetForTests();
  const t0 = 1_000_000;
  openFollowUp('chan-1', 25, t0);
  assert.equal(isFollowUpOpen('chan-2', t0 + 1_000), false);
});

test('"stop listening" shuts the window immediately', () => {
  _resetForTests();
  const t0 = 1_000_000;
  openFollowUp('chan-1', 25, t0);
  closeFollowUp('chan-1');
  assert.equal(isFollowUpOpen('chan-1', t0 + 1_000), false);
});

test('a zero or negative window disables follow-up mode outright', () => {
  _resetForTests();
  assert.equal(openFollowUp('chan-1', 0), false);
  assert.equal(openFollowUp('chan-1', -5), false);
  assert.equal(isFollowUpOpen('chan-1'), false);
});

test('closing an already-closed window is harmless', () => {
  _resetForTests();
  closeFollowUp('chan-1');
  closeFollowUp('chan-1');
  assert.equal(isFollowUpOpen('chan-1'), false);
});

// NOT covered here: armFollowUp's epoch guard — that "Max, stop listening"
// said while he is still speaking survives the arm which fires when playback
// ends. It needs a live AudioPlayer and a guild settings row to exercise, so
// it is verified by reading, not by test.

// -- stop phrases ------------------------------------------------------------

test('the default stop-speaking phrases match how people actually say them', () => {
  for (const said of ['Max, stop speaking!', 'max stop talking', 'MAX, SHUT UP',
    'ok max be quiet', 'stop talking max']) {
    assert.equal(matchesAny(said, VOICE_STOP_SPEAKING_WORDS), true, said);
  }
});

test('the default stop-listening phrases match how people actually say them', () => {
  for (const said of ['Max, stop listening.', 'max go to sleep',
    'alright max we are done', 'stop listening max']) {
    assert.equal(matchesAny(said, VOICE_STOP_LISTENING_WORDS), true, said);
  }
});

test('the default stop phrases are already in canonical form', () => {
  // matchesAny() now normalizes both sides, so punctuation in a phrase is no
  // longer fatal — but a default that isn't already canonical is a default
  // that doesn't read the way it will be stored and shown back on the
  // dashboard. Keep them written the way they end up.
  for (const w of [...VOICE_STOP_SPEAKING_WORDS, ...VOICE_STOP_LISTENING_WORDS]) {
    assert.equal(normalizePhrase(w), w, `not in canonical form: ${w}`);
  }
});

test('every stop phrase is multi-word, since matching is substring-based', () => {
  // A bare "stop" would fire inside "stopping", "nonstop", "stop by later".
  for (const w of [...VOICE_STOP_SPEAKING_WORDS, ...VOICE_STOP_LISTENING_WORDS]) {
    assert.ok(w.includes(' '), `single-word stop phrase is too greedy: ${w}`);
  }
});

test('the two stop lists are disjoint, so an utterance means one thing', () => {
  for (const w of VOICE_STOP_SPEAKING_WORDS) {
    assert.equal(VOICE_STOP_LISTENING_WORDS.includes(w), false, w);
  }
});

test('ordinary conversation does not trip a stop phrase', () => {
  for (const said of ['we should stop by the store', 'the show was nonstop action',
    'max is listening to music', 'i cannot stop laughing']) {
    assert.equal(matchesAny(said, VOICE_STOP_SPEAKING_WORDS), false, said);
    assert.equal(matchesAny(said, VOICE_STOP_LISTENING_WORDS), false, said);
  }
});

// -- the PASS sentinel -------------------------------------------------------

test('a bare PASS is recognized, including the junk models add to it', () => {
  for (const reply of ['PASS', 'pass', ' PASS ', 'PASS.', '"PASS"', '*PASS*', 'Pass!']) {
    assert.equal(isPass(reply), true, JSON.stringify(reply));
  }
});

test('a real answer that merely mentions passing is not swallowed', () => {
  for (const reply of ['pass me the link when you get a sec', 'I would pass on that',
    'That is a hard pass from me.', 'PASS the ball, obviously']) {
    assert.equal(isPass(reply), false, reply);
  }
});
