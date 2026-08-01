import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePhrase, parsePhraseList, formatPhraseList, PHRASE_LIST_KEYS,
} from '../src/phrases.js';
import { matchesAny } from '../src/voice.js';

// -- the point of the whole change -------------------------------------------

test('a phrase can contain a comma', () => {
  const list = parsePhraseList('[hey max] [max, are you there?]');
  assert.deepEqual(list, ['hey max', 'max are you there']);
  assert.equal(matchesAny('Max, are you there??', list), true);
});

test('brackets keep phrases whole where commas would have split them', () => {
  assert.deepEqual(parsePhraseList('[one, two] [three]'), ['one two', 'three']);
  // The old behaviour, for contrast: commas would have made three entries.
  assert.deepEqual(parsePhraseList('one, two, three'), ['one', 'two', 'three']);
});

// -- parsing -----------------------------------------------------------------

test('whitespace between and inside groups is tidied', () => {
  assert.deepEqual(parsePhraseList('  [ hey   max ]   [yo max]  '), ['hey max', 'yo max']);
});

test('an array passes through, normalized', () => {
  assert.deepEqual(parsePhraseList(['Hey Max!', 'YO  max']), ['hey max', 'yo max']);
});

test('the old comma format still parses, so saving cannot wipe a list', () => {
  assert.deepEqual(parsePhraseList('hey max, hey andrew'), ['hey max', 'hey andrew']);
});

test('a half-typed bracket falls back to commas rather than erasing everything', () => {
  assert.deepEqual(parsePhraseList('[hey max'), ['hey max']);
  assert.deepEqual(parsePhraseList('hey max]'), ['hey max']);
  assert.deepEqual(parsePhraseList('[hey max, hey andrew'), ['hey max', 'hey andrew']);
});

test('empty input clears the list, which must stay possible', () => {
  assert.deepEqual(parsePhraseList(''), []);
  assert.deepEqual(parsePhraseList('   '), []);
  assert.deepEqual(parsePhraseList([]), []);
  assert.deepEqual(parsePhraseList(null), []);
  assert.deepEqual(parsePhraseList(undefined), []);
});

test('empty groups are dropped rather than becoming a phrase that matches everything', () => {
  // A "" needle would make String.includes() true for every utterance.
  assert.deepEqual(parsePhraseList('[hey max] [] [  ]'), ['hey max']);
  assert.equal(matchesAny('completely unrelated chatter', parsePhraseList('[] []')), false);
});

test('duplicates collapse, first spelling wins', () => {
  assert.deepEqual(parsePhraseList('[hey max] [Hey  Max!] [yo max]'), ['hey max', 'yo max']);
});

test('text outside brackets is ignored once real groups are present', () => {
  assert.deepEqual(parsePhraseList('[hey max] stray [yo max]'), ['hey max', 'yo max']);
});

test('nested-looking brackets do not swallow the rest of the input', () => {
  assert.deepEqual(parsePhraseList('[[hey max]] [yo max]'), ['hey max', 'yo max']);
});

// -- normalization -----------------------------------------------------------

test('normalizePhrase collapses case and punctuation', () => {
  assert.equal(normalizePhrase("Max, ARE you there?!"), 'max are you there');
  assert.equal(normalizePhrase("that's all, max"), 'that s all max');
  assert.equal(normalizePhrase('  spaced   out  '), 'spaced out');
  assert.equal(normalizePhrase(''), '');
  assert.equal(normalizePhrase(null), '');
});

test('normalizePhrase is idempotent', () => {
  const once = normalizePhrase('Max, are you there?');
  assert.equal(normalizePhrase(once), once);
});

// -- round trip --------------------------------------------------------------

test('format and parse round-trip', () => {
  const list = ['hey max', 'max are you there', 'yo max'];
  assert.equal(formatPhraseList(list), '[hey max] [max are you there] [yo max]');
  assert.deepEqual(parsePhraseList(formatPhraseList(list)), list);
});

test('formatPhraseList tolerates junk', () => {
  assert.equal(formatPhraseList(null), '');
  assert.equal(formatPhraseList([]), '');
});

// -- matching ----------------------------------------------------------------

test('matching ignores punctuation and case on BOTH sides', () => {
  assert.equal(matchesAny('Hey, Max! you around?', ['hey max']), true);
  assert.equal(matchesAny('hey max you around', ['Hey, Max!']), true);
});

test('matchesAny survives an empty or missing word list', () => {
  assert.equal(matchesAny('hey max', []), false);
  assert.equal(matchesAny('hey max', undefined), false);
  assert.equal(matchesAny('', ['hey max']), false);
});

test('all four voice lists are treated as phrase lists', () => {
  assert.deepEqual([...PHRASE_LIST_KEYS].sort(), [
    'voice_cancel_words',
    'voice_stop_listening_words',
    'voice_stop_speaking_words',
    'voice_wake_words',
  ]);
});
