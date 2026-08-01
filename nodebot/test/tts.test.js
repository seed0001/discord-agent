import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripVoiceTags, isS2, splitForTts } from '../src/tts.js';

test('strips S1 parenthesis emotion tags', () => {
  assert.equal(stripVoiceTags('(excited) lets go! (chuckling) nice'), 'lets go! nice');
});

test('strips S2 free-form bracket tags', () => {
  assert.equal(stripVoiceTags('[relaxed] all good [laughing nervously] for real'), 'all good for real');
});

test('leaves plain text with no tags untouched', () => {
  assert.equal(stripVoiceTags('just a normal reply'), 'just a normal reply');
});

test('does not strip parentheses that are not a recognized tag', () => {
  assert.equal(stripVoiceTags('check the repo (main branch) please'), 'check the repo (main branch) please');
});

test('isS2 is true for the default FISH_TTS_MODEL (s2.1-pro-free)', () => {
  // config.js's default is 's2.1-pro-free' when FISH_TTS_MODEL isn't set,
  // which starts with "s2" — this locks that default in place.
  assert.equal(isS2(), true);
});

test('short text stays a single chunk', () => {
  assert.deepEqual(splitForTts('Just one line.', 100), ['Just one line.']);
});

test('keeps every word of a multi-paragraph reply', () => {
  // The truncation bug: a long reply was sliced and the rest never spoken.
  const para = 'This is a sentence that carries some real weight. ';
  const text = `${para.repeat(20)}\n\n${para.repeat(20)}`;
  const chunks = splitForTts(text, 700);
  assert.ok(chunks.length > 1, 'should split rather than truncate');
  const spoken = chunks.join(' ').replace(/\s+/g, ' ').trim();
  const original = text.replace(/\s+/g, ' ').trim();
  assert.equal(spoken, original);
});

test('no chunk exceeds the limit', () => {
  const text = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} here.`).join(' ');
  for (const chunk of splitForTts(text, 120)) assert.ok(chunk.length <= 120);
});

test('splits at sentence boundaries, not mid-word', () => {
  const chunks = splitForTts('First sentence here. Second sentence here. Third one.', 25);
  for (const chunk of chunks) assert.ok(!/\w$/.test(chunk) || chunk.endsWith('.'));
});

test('hard-splits a single sentence longer than the limit', () => {
  const chunks = splitForTts('x'.repeat(250), 100);
  assert.deepEqual(chunks.map((c) => c.length), [100, 100, 50]);
});

test('empty or whitespace-only text yields no chunks', () => {
  assert.deepEqual(splitForTts('', 100), []);
  assert.deepEqual(splitForTts('   \n\n  ', 100), []);
});
