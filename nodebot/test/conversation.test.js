// node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordTurn, getRecentTurns, formatForPrompt } from '../src/conversation.js';

function freshGuildId() {
  return `test-${Math.random().toString(36).slice(2)}`;
}

test('recordTurn ignores empty/whitespace-only text', () => {
  const gid = freshGuildId();
  recordTurn(gid, { source: 'text', channel: 'general', speaker: 'alice', text: '   ' });
  assert.deepEqual(getRecentTurns(gid), []);
});

test('a text turn and a voice turn land in the same shared buffer', () => {
  const gid = freshGuildId();
  recordTurn(gid, { source: 'text', channel: 'general', speaker: 'travis', text: 'posted the invoice' });
  recordTurn(gid, { source: 'voice', channel: 'General VC', speaker: 'travis', text: 'did you see that' });
  const turns = getRecentTurns(gid);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].source, 'text');
  assert.equal(turns[1].source, 'voice');
});

test('formatForPrompt tags each line with where it happened', () => {
  const gid = freshGuildId();
  recordTurn(gid, { source: 'text', channel: 'general', speaker: 'alice', text: 'hi' });
  recordTurn(gid, { source: 'voice', channel: 'General VC', speaker: 'bob', text: 'hey' });
  const text = formatForPrompt(gid);
  assert.equal(text, '[#general] alice: hi\n[voice/General VC] bob: hey');
});

test('missing channel falls back to bare source', () => {
  const gid = freshGuildId();
  recordTurn(gid, { source: 'text', channel: '', speaker: 'carol', text: 'hi' });
  assert.equal(formatForPrompt(gid), '[text] carol: hi');
});

test('guilds are isolated from each other', () => {
  const g1 = freshGuildId();
  const g2 = freshGuildId();
  recordTurn(g1, { source: 'text', channel: 'general', speaker: 'alice', text: 'in guild 1' });
  recordTurn(g2, { source: 'text', channel: 'general', speaker: 'bob', text: 'in guild 2' });
  assert.equal(getRecentTurns(g1).length, 1);
  assert.equal(getRecentTurns(g2).length, 1);
  assert.equal(getRecentTurns(g1)[0].speaker, 'alice');
});

test('buffer caps at MAX_TURNS, dropping the oldest first', () => {
  const gid = freshGuildId();
  for (let i = 0; i < 50; i += 1) {
    recordTurn(gid, { source: 'text', channel: 'general', speaker: 'alice', text: `turn ${i}` });
  }
  const turns = getRecentTurns(gid, 100);
  assert.ok(turns.length <= 40, `expected buffer capped at 40, got ${turns.length}`);
  assert.equal(turns.at(-1).text, 'turn 49');
  assert.notEqual(turns[0].text, 'turn 0'); // the earliest ones got dropped
});
