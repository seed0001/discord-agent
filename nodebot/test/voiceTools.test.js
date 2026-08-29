// join_voice / leave_voice — the conversational voice-presence controls.
// voice.js's real playback/connection machinery is stood in for by a fake,
// same as music.test.js does, so these exercise the tool logic (who gets
// joined where, what gets said back) without a @discordjs/voice connection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as voiceTools from '../src/voiceTools.js';

function withStubs(fn) {
  return async () => {
    voiceTools._setAvailableForTests(() => true);
    try {
      await fn();
    } finally {
      voiceTools._setAvailableForTests(null);
      voiceTools._setVoiceModuleForTests(null);
    }
  };
}

/** A stand-in for voice.js. `joinResult` is what wakeGuild resolves to;
 * `inChannel` is what currentVoiceChannel returns. */
function fakeVoice({ joinResult = { joined: true, channel: 'General' }, inChannel = null } = {}) {
  const calls = { wake: [], sleep: 0 };
  return {
    calls,
    async wakeGuild(guild, channel) {
      calls.wake.push(channel?.name ?? null);
      return joinResult;
    },
    sleepGuild() { calls.sleep += 1; },
    currentVoiceChannel() { return inChannel; },
  };
}

function fakeGuild(voiceChannelNames = ['General', 'Gaming']) {
  const cache = new Map(voiceChannelNames.map((name, i) => [
    `vc-${i}`, { id: `vc-${i}`, name, type: 2 },
  ]));
  return { id: 'g1', channels: { cache } };
}

function fakeMessage(guild, { inVoice = null } = {}) {
  return {
    guild,
    member: { voice: { channel: inVoice } },
    author: { id: 'u1' },
  };
}

test('enabled() follows the transcription availability seam', () => {
  voiceTools._setAvailableForTests(() => false);
  assert.equal(voiceTools.enabled(), false);
  voiceTools._setAvailableForTests(() => true);
  assert.equal(voiceTools.enabled(), true);
  voiceTools._setAvailableForTests(null);
});

test('join_voice with no channel joins the channel the asker is in', withStubs(async () => {
  const guild = fakeGuild();
  const askersChannel = { id: 'vc-0', name: 'General', type: 2 };
  const voice = fakeVoice({ joinResult: { joined: true, channel: 'General' } });
  voiceTools._setVoiceModuleForTests(voice);

  const result = await voiceTools.execute(null, fakeMessage(guild, { inVoice: askersChannel }), 'join_voice', {});
  assert.match(result, /Joined \*\*General\*\*/);
  assert.deepEqual(voice.calls.wake, ['General']);
}));

test('join_voice with no channel and the asker not in voice asks them to hop in', withStubs(async () => {
  voiceTools._setVoiceModuleForTests(fakeVoice());
  const result = await voiceTools.execute(null, fakeMessage(fakeGuild()), 'join_voice', {});
  assert.match(result, /^Error:/);
  assert.match(result, /hop into a voice channel first/);
}));

test('join_voice with a named channel resolves it (case / partial)', withStubs(async () => {
  const voice = fakeVoice({ joinResult: { joined: true, channel: 'Gaming' } });
  voiceTools._setVoiceModuleForTests(voice);
  const result = await voiceTools.execute(null, fakeMessage(fakeGuild()), 'join_voice', { channel: 'gaming' });
  assert.match(result, /Joined \*\*Gaming\*\*/);
  assert.deepEqual(voice.calls.wake, ['Gaming']);
}));

test('join_voice with an unknown channel name says so', withStubs(async () => {
  voiceTools._setVoiceModuleForTests(fakeVoice());
  const result = await voiceTools.execute(null, fakeMessage(fakeGuild()), 'join_voice', { channel: 'nowhere' });
  assert.match(result, /^Error:/);
  assert.match(result, /couldn't find a voice channel called "nowhere"/);
}));

test('join_voice relays a not-allowed channel', withStubs(async () => {
  voiceTools._setVoiceModuleForTests(fakeVoice({ joinResult: { joined: false, reason: 'not-allowed' } }));
  const guild = fakeGuild();
  const askersChannel = { id: 'vc-0', name: 'General', type: 2 };
  const result = await voiceTools.execute(null, fakeMessage(guild, { inVoice: askersChannel }), 'join_voice', {});
  assert.match(result, /^Error:/);
  assert.match(result, /list of allowed voice channels/);
}));

test('leave_voice disconnects and reports the stay-out', withStubs(async () => {
  const voice = fakeVoice({ inChannel: { name: 'General' } });
  voiceTools._setVoiceModuleForTests(voice);
  const result = await voiceTools.execute(null, fakeMessage(fakeGuild()), 'leave_voice', {});
  assert.equal(voice.calls.sleep, 1);
  assert.match(result, /Left voice/);
  assert.match(result, /stay out until/);
}));

test('leave_voice when not in a channel still sets the stay-out flag', withStubs(async () => {
  const voice = fakeVoice({ inChannel: null });
  voiceTools._setVoiceModuleForTests(voice);
  const result = await voiceTools.execute(null, fakeMessage(fakeGuild()), 'leave_voice', {});
  assert.equal(voice.calls.sleep, 1);
  assert.match(result, /wasn't in a voice channel, but noted/);
}));

test('the tools are refused up front when voice monitoring is not set up', withStubs(async () => {
  voiceTools._setAvailableForTests(() => false);
  voiceTools._setVoiceModuleForTests(fakeVoice());
  const result = await voiceTools.execute(null, fakeMessage(fakeGuild()), 'join_voice', { channel: 'General' });
  assert.match(result, /^Error:/);
  assert.match(result, /voice monitoring is not set up/);
}));

test('an unknown tool name is reported, not thrown', withStubs(async () => {
  const result = await voiceTools.execute(null, fakeMessage(fakeGuild()), 'teleport', {});
  assert.match(result, /unknown tool/);
}));
