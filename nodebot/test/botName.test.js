// The bot's name used to be the literal 'Max' in four modules. These cover
// the two things that actually broke when it was renamed: the name the bot
// speaks under in the shared conversation buffer, and the voice phrases built
// around it ("max stop speaking" can never fire for a bot called Amy).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as db from '../src/db.js';
import { botName, botNameForPhrases, voicePhrases, BOT_NAME_FALLBACK } from '../src/botName.js';

const clientNamed = (displayName, username = 'fallback-username') =>
  ({ user: { displayName, username } });

function withDb(fn) {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nodebot-test-'));
    db.initDb(path.join(dir, 'test.db'));
    try {
      await fn();
    } finally {
      db.closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

// -- resolution order --------------------------------------------------------

test('uses the Discord display name when nothing is overridden', withDb(() => {
  assert.equal(botName(clientNamed('Amy'), '1'), 'Amy');
}));

test('falls back to the username when there is no display name', withDb(() => {
  assert.equal(botName(clientNamed(null, 'amy-bot'), '1'), 'amy-bot');
}));

test('a saved bot_name overrides the Discord name', withDb(() => {
  db.setSetting('1', 'bot_name', 'Amy');
  assert.equal(botName(clientNamed('Max'), '1'), 'Amy');
}));

test('the override is per guild', withDb(() => {
  db.setSetting('1', 'bot_name', 'Amy');
  assert.equal(botName(clientNamed('Max'), '2'), 'Max');
}));

test('a blank or whitespace override is ignored, not used as the name', withDb(() => {
  db.setSetting('1', 'bot_name', '   ');
  assert.equal(botName(clientNamed('Amy'), '1'), 'Amy');
}));

test('never yields undefined when the client is not ready', withDb(() => {
  assert.equal(botName(null, '1'), BOT_NAME_FALLBACK);
  assert.equal(botName({}, '1'), BOT_NAME_FALLBACK);
}));

test('works before initDb rather than throwing', () => {
  // index.js builds prompts on events that can land during startup.
  assert.equal(botName(clientNamed('Amy'), '1'), 'Amy');
});

test('normalizes for phrase matching', withDb(() => {
  assert.equal(botNameForPhrases(clientNamed('Amy 🤖'), '1'), 'amy');
}));

// -- derived voice phrases ---------------------------------------------------

test('wake and stop phrases follow the bot name', withDb(() => {
  const client = clientNamed('Amy');
  assert.deepEqual(voicePhrases(client, '1', 'voice_wake_words'), ['hey amy', 'amy are you there']);
  assert.ok(voicePhrases(client, '1', 'voice_stop_speaking_words').includes('amy stop speaking'));
  assert.ok(voicePhrases(client, '1', 'voice_stop_listening_words').includes('amy stop listening'));
  assert.ok(voicePhrases(client, '1', 'voice_leave_words').includes('amy go to sleep'));
}));

test('no derived phrase still says max after a rename', withDb(() => {
  const client = clientNamed('Amy');
  for (const key of ['voice_wake_words', 'voice_stop_speaking_words',
    'voice_stop_listening_words', 'voice_leave_words']) {
    for (const phrase of voicePhrases(client, '1', key)) {
      assert.ok(!phrase.includes('max'), `${key} still contains "max": ${phrase}`);
    }
  }
}));

test('cancel words are name-independent and left alone', withDb(() => {
  const phrases = voicePhrases(clientNamed('Amy'), '1', 'voice_cancel_words');
  assert.ok(phrases.includes('never mind'));
}));

test('a list the guild saved wins over the derived one', withDb(() => {
  // The important one: deriving over the top would silently rewrite wake
  // words an admin deliberately chose.
  db.setSetting('1', 'voice_wake_words', ['yo robot']);
  assert.deepEqual(voicePhrases(clientNamed('Amy'), '1', 'voice_wake_words'), ['yo robot']);
}));

test('an explicitly emptied list stays empty rather than re-deriving', withDb(() => {
  db.setSetting('1', 'voice_wake_words', []);
  assert.deepEqual(voicePhrases(clientNamed('Amy'), '1', 'voice_wake_words'), []);
}));

test('a name that normalizes away keeps the shipped default', withDb(() => {
  // 'hey ' would be a phrase that matches everything.
  const phrases = voicePhrases(clientNamed('🤖🤖'), '1', 'voice_wake_words');
  assert.ok(phrases.length > 0);
  for (const phrase of phrases) assert.ok(phrase.trim().length > 1);
}));

test('the derived name is the override when one is set', withDb(() => {
  db.setSetting('1', 'bot_name', 'Pixel');
  assert.ok(voicePhrases(clientNamed('Amy'), '1', 'voice_wake_words').includes('hey pixel'));
}));

test('{ai} in saved wake words expands to the effective bot name', withDb(() => {
  db.setSetting('1', 'voice_wake_words', ['hey {ai}', '{ai} you around']);
  const list = voicePhrases(clientNamed('Helena'), '1', 'voice_wake_words');
  assert.ok(list.includes('hey helena'));
  assert.ok(list.includes('helena you around'));
}));

test('a guild whose {ai} phrases all collapse keeps the shipped defaults', withDb(() => {
  // Dropping the templates must not leave the server with no wake words at
  // all — that would make voice unreachable rather than merely over-eager.
  db.setSetting('1', 'voice_wake_words', ['hey {ai}', '{ai} you around']);
  const list = voicePhrases(clientNamed('🤖'), '1', 'voice_wake_words');
  assert.ok(list.length > 0, 'should fall back rather than return nothing');
  assert.equal(list.includes('hey'), false, 'and never install a bare "hey"');
}));
