// Audible cues: tone synthesis, the stored-config parser, and the routing
// between a Discord soundboard sound and the built-in tone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as db from '../src/db.js';
import { renderTone, earconPcm, EARCONS, SAMPLE_RATE } from '../src/earcon.js';
import { parseCue, cueFor, playCue, resetWarnings, CUE_EVENTS } from '../src/cues.js';

function withDb(fn) {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nodebot-test-'));
    db.initDb(path.join(dir, 'test.db'));
    resetWarnings();
    try {
      await fn();
    } finally {
      db.closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

// -- tone synthesis ----------------------------------------------------------

test('a rendered tone is the right length of 48k stereo 16-bit PCM', () => {
  const pcm = renderTone([{ freq: 440, ms: 100 }]);
  // 100ms * 48000 frames/s * 2 channels * 2 bytes
  assert.equal(pcm.length, Math.round(0.1 * SAMPLE_RATE) * 4);
});

test('both channels carry the same sample', () => {
  const pcm = renderTone([{ freq: 440, ms: 20 }]);
  for (let frame = 0; frame < 100; frame += 1) {
    assert.equal(pcm.readInt16LE(frame * 4), pcm.readInt16LE(frame * 4 + 2));
  }
});

test('tones start and end at silence, so there is no click', () => {
  const pcm = renderTone([{ freq: 440, ms: 100 }]);
  assert.equal(pcm.readInt16LE(0), 0);
  assert.equal(pcm.readInt16LE(pcm.length - 4), 0);
});

test('a zero frequency segment is silence', () => {
  const pcm = renderTone([{ freq: 0, ms: 10 }]);
  for (let i = 0; i < pcm.length; i += 2) assert.equal(pcm.readInt16LE(i), 0);
});

test('tones stay well inside 16-bit range', () => {
  const pcm = renderTone([{ freq: 440, ms: 50, gain: 1.0 }]);
  let peak = 0;
  for (let i = 0; i < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
  assert.ok(peak <= 32767, `peak ${peak} clipped`);
});

test('every configured earcon renders and is cached by identity', () => {
  for (const kind of Object.keys(EARCONS)) {
    const pcm = earconPcm(kind);
    assert.ok(pcm && pcm.length > 0, `${kind} rendered empty`);
    assert.equal(earconPcm(kind), pcm, `${kind} re-rendered instead of caching`);
  }
});

test('every cue event has a matching earcon', () => {
  // A cue with no tone would silently do nothing when set to "tone".
  for (const event of CUE_EVENTS) assert.ok(EARCONS[event], `no earcon for ${event}`);
});

test('an unknown earcon is null rather than a throw', () => {
  assert.equal(earconPcm('nope'), null);
});

// -- config parsing ----------------------------------------------------------

test('cue config parses across the shapes it can be stored in', () => {
  assert.deepEqual(parseCue({ mode: 'off' }), { mode: 'off' });
  assert.deepEqual(parseCue({ mode: 'tone' }), { mode: 'tone' });
  assert.deepEqual(parseCue('off'), { mode: 'off' });
  assert.deepEqual(parseCue('tone'), { mode: 'tone' });
  assert.deepEqual(parseCue({ mode: 'soundboard', soundId: '77' }),
    { mode: 'soundboard', soundId: '77', soundGuildId: undefined });
  assert.deepEqual(parseCue('sound:77'),
    { mode: 'soundboard', soundId: '77', soundGuildId: undefined });
});

test('a soundboard cue with no sound falls back to a tone, not silence', () => {
  assert.deepEqual(parseCue({ mode: 'soundboard' }), { mode: 'tone' });
});

test('null and junk parse without throwing on the hot path', () => {
  assert.deepEqual(parseCue(null), { mode: 'off' });
  assert.deepEqual(parseCue(12345), { mode: 'tone' });
  assert.deepEqual(parseCue({ mode: 'nonsense' }), { mode: 'tone' });
});

test('defaults: thinking, engaging and stopped_listening on, declined off', withDb(() => {
  assert.equal(cueFor('1', 'thinking').mode, 'tone');
  assert.equal(cueFor('1', 'engaging').mode, 'tone');
  assert.equal(cueFor('1', 'declined').mode, 'off');
  assert.equal(cueFor('1', 'stopped_listening').mode, 'tone');
}));

// -- playback routing --------------------------------------------------------

const fakeGuild = () => ({ id: '1', client: { user: { username: 'Amy' } } });

test('a soundboard cue sends the sound and does not play a tone', withDb(async () => {
  const sent = [];
  const channel = { sendSoundboardSound: async (opts) => sent.push(opts) };
  const result = await playCue(fakeGuild(), channel, 'thinking', {
    cue: { mode: 'soundboard', soundId: '77' },
  });
  assert.equal(result, 'soundboard');
  assert.deepEqual(sent, [{ soundId: '77', guildId: '1' }]);
}));

test('a sound from another guild passes that guild through', withDb(async () => {
  const sent = [];
  const channel = { sendSoundboardSound: async (opts) => sent.push(opts) };
  await playCue(fakeGuild(), channel, 'thinking', {
    cue: { mode: 'soundboard', soundId: '77', soundGuildId: '999' },
  });
  assert.equal(sent[0].guildId, '999');
}));

test('the players map is forwarded so a tone cannot play over the bot speaking', withDb(async () => {
  // playEarcon must share voice.js's player map; a private player would let a
  // cue play straight over a reply that is already being spoken.
  const players = new Map();
  const busy = { state: { status: 'playing' }, on() {}, off() {}, play() {} };
  players.set('1', busy);
  const result = await playCue(fakeGuild(), {}, 'thinking', {
    cue: { mode: 'tone' },
    players,
    earcon: { connection: {} },
  });
  assert.equal(result, 'failed', 'played a tone while the player was busy');
}));

test('a failing soundboard falls back to the tone rather than silence', withDb(async () => {
  const channel = { sendSoundboardSound: async () => { throw new Error('Missing Permissions'); } };
  const result = await playCue(fakeGuild(), channel, 'thinking', {
    cue: { mode: 'soundboard', soundId: '77' },
    // No voice connection in a test, so the tone reports 'failed' — what
    // matters is that it TRIED the tone instead of stopping at the error.
    earcon: { connection: null },
  });
  assert.equal(result, 'failed');
}));

test('an off cue plays nothing at all', withDb(async () => {
  let called = false;
  const channel = { sendSoundboardSound: async () => { called = true; } };
  assert.equal(await playCue(fakeGuild(), channel, 'declined', { cue: { mode: 'off' } }), 'off');
  assert.equal(called, false);
}));

test('quiet mode silences cues', withDb(async () => {
  // Podcast mode means the bot makes no sound. A cue is a sound.
  db.setSetting('1', 'quiet_mode', true);
  let called = false;
  const channel = { sendSoundboardSound: async () => { called = true; } };
  assert.equal(await playCue(fakeGuild(), channel, 'thinking', {
    cue: { mode: 'soundboard', soundId: '77' },
  }), 'off');
  assert.equal(called, false);
}));

test('a channel with no soundboard support falls back to the tone', withDb(async () => {
  const result = await playCue(fakeGuild(), {}, 'thinking', {
    cue: { mode: 'soundboard', soundId: '77' },
    earcon: { connection: null },
  });
  assert.equal(result, 'failed');
}));
