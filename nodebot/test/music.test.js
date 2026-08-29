// Music generation. music.js's HTTP goes through the global fetch, which is
// swapped for a fake here — same seam media.test.js uses — with a fake
// streamed body standing in for OpenRouter's SSE audio-output framing, since
// the sandbox's egress allowlist blocks OpenRouter anyway and these are
// about control flow: how SSE deltas become one audio Buffer, and who is
// allowed to spend money.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PermissionsBitField } from 'discord.js';
import * as db from '../src/db.js';
import * as music from '../src/music.js';
import * as musicTools from '../src/musicTools.js';

const OWNER = 'owner-1';

function withFetch(fn, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  return run().finally(() => { globalThis.fetch = original; });
}

/** Fakes OpenRouter's streamed response: one "data: {...}\n\n" SSE chunk per
 * event, terminated by "data: [DONE]" — matches what music.js's reader loop
 * reads via getReader() (it splits on single newlines, so the blank line in
 * each "\n\n" here is just an extra empty line it skips over). */
function sseResponse(events) {
  const lines = [...events.map((e) => `data: ${JSON.stringify(e)}\n\n`), 'data: [DONE]\n\n'];
  const encoder = new TextEncoder();
  let i = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        async read() {
          if (i >= lines.length) return { done: true, value: undefined };
          const value = encoder.encode(lines[i]);
          i += 1;
          return { done: false, value };
        },
        releaseLock() {},
      }),
    },
  };
}

function errorResponse(body, status = 400) {
  return { ok: false, status, text: async () => JSON.stringify(body) };
}

const audioChunk = (data, format) => ({ choices: [{ delta: { audio: { data, format } } }] });
const b64 = (text) => Buffer.from(text).toString('base64');

// ===========================================================================
// music.js
// ===========================================================================

test('decodes each audio delta on its own and concatenates the bytes', () => withFetch(
  // Verified against a working reference implementation: each delta.audio.data
  // chunk is its OWN independently base64-encoded (and independently padded)
  // fragment — decode every chunk separately, then concatenate the resulting
  // byte Buffers. Concatenating the base64 STRINGS first and decoding once
  // (the previous, unverified approach here) breaks the moment a chunk's
  // padding lands mid-stream, which is exactly what this fixture catches:
  // 'SONG' and 'BYTES' are each padded on their own, same as real chunks.
  async () => sseResponse([audioChunk(b64('SONG'), 'mp3'), audioChunk(b64('BYTES'))]),
  async () => {
    const clip = await music.generateMusic('a cheerful jingle');
    assert.ok(Buffer.isBuffer(clip.data));
    assert.equal(clip.data.toString(), 'SONGBYTES');
    assert.equal(clip.mediaType, 'audio/mpeg');
  },
));

test("length 'short' (default) uses the clip model, 'full' uses the pro model", () => {
  let sent = null;
  let sentHeaders = null;
  return withFetch(
    async (_url, opts) => {
      sent = JSON.parse(opts.body);
      sentHeaders = opts.headers;
      return sseResponse([audioChunk(b64('x'))]);
    },
    async () => {
      await music.generateMusic('a jingle');
      assert.equal(sent.model, 'google/lyria-3-clip-preview');
      assert.deepEqual(sent.modalities, ['text', 'audio']);
      assert.equal(sent.stream, true, 'OpenRouter rejects audio output without stream: true');
      assert.ok(sentHeaders['HTTP-Referer'], 'the reference implementation sends this on every audio-output call');

      await music.generateMusic('a full song', { length: 'full' });
      assert.equal(sent.model, 'google/lyria-3-pro-preview');
    },
  );
});

test('costUsd is read off a usage.cost field in the stream, 0 when absent', () => withFetch(
  async () => sseResponse([audioChunk(b64('x')), { usage: { cost: 0.04 } }]),
  async () => {
    const withCost = await music.generateMusic('a jingle');
    assert.equal(withCost.costUsd, 0.04);
    globalThis.fetch = async () => sseResponse([audioChunk(b64('x'))]);
    const withoutCost = await music.generateMusic('a jingle');
    assert.equal(withoutCost.costUsd, 0);
  },
));

test("a non-200 surfaces the API's own error message, not just the status", () => withFetch(
  async () => errorResponse({ error: { message: 'model overloaded' } }, 429),
  async () => {
    await assert.rejects(
      music.generateMusic('a jingle'),
      (err) => err instanceof music.MusicError && /429/.test(err.message) && /model overloaded/.test(err.message),
    );
  },
));

test('an error event mid-stream aborts with its message', () => withFetch(
  async () => sseResponse([audioChunk(b64('SO')), { error: { message: 'content policy violation' } }]),
  async () => {
    await assert.rejects(music.generateMusic('a jingle'), /content policy violation/);
  },
));

test('a stream that never carries audio is a MusicError', () => withFetch(
  async () => sseResponse([{ choices: [{ delta: {} }] }]),
  async () => {
    await assert.rejects(music.generateMusic('a jingle'), /returned no audio/);
  },
));

test('a blank prompt is rejected before any request goes out', () => {
  let calls = 0;
  return withFetch(
    async () => { calls += 1; return sseResponse([audioChunk(b64('x'))]); },
    async () => {
      await assert.rejects(music.generateMusic('   '), music.MusicError);
      await assert.rejects(music.generateMusic(''), /prompt is required/);
      assert.equal(calls, 0, 'a blank prompt must not cost a request');
    },
  );
});

// ===========================================================================
// musicTools.js
// ===========================================================================

function withDb(fn) {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nodebot-music-test-'));
    db.initDb(path.join(dir, 'test.db'));
    // The "song I just made" cache is module-level — without this reset a
    // generate_music left pending by an earlier test leaks into the next.
    musicTools._resetForTests();
    try {
      await fn();
    } finally {
      db.closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** A GuildMember with the given Discord permission flags and role ids. */
function fakeMember(id, { flags = [], roleIds = [] } = {}) {
  return {
    id,
    user: { id, username: `user-${id}`, bot: false },
    roles: { cache: new Map(roleIds.map((r) => [r, { id: r, name: `role-${r}` }])) },
    permissions: { has: (flag) => flags.includes(flag) },
  };
}

/** Only the bits the handlers touch. `voiceMembers`, when given, stands in for
 * the bot's current voice channel — an array of {id, bot?, shareable?} — so
 * the DJ-scope path can be exercised without a real @discordjs/voice
 * connection. */
function fakeMessage(authorId, {
  flags = [], roleIds = [], inGuild = true,
} = {}) {
  const sent = [];
  const deleted = [];
  const member = inGuild ? fakeMember(authorId, { flags, roleIds }) : null;
  const membersCache = new Map(member ? [[authorId, member]] : []);
  return {
    guild: {
      id: '1',
      roles: { cache: new Map() },
      members: {
        cache: membersCache,
        fetch: async (id) => {
          const m = membersCache.get(id);
          if (!m) throw new Error('Unknown Member');
          return m;
        },
      },
    },
    author: { id: authorId },
    member,
    channel: {
      send: async (payload) => {
        sent.push(payload);
        const notice = { id: `msg-${sent.length}`, edit: async () => {}, delete: async () => { deleted.push(notice.id); } };
        return notice;
      },
    },
    _sent: sent,
    _deleted: deleted,
  };
}

/** A stand-in for voice.js: playback + which channel the bot is "in". Pass
 * `members` as [{id, shareable}] to populate the current voice channel; each
 * shareable member also gets their music_prefs row set. */
function fakeVoice({ connected = true, busy = false, guildId = '1', members = null } = {}) {
  const played = [];
  let playing = false;
  if (members) {
    for (const m of members) {
      if (m.shareable) db.setMusicShareable(guildId, m.id, true);
    }
  }
  return {
    played,
    currentVoiceChannel() {
      if (!members) return null;
      return {
        members: new Map(members.map((m) => [m.id, { id: m.id, user: { id: m.id, bot: Boolean(m.bot) } }])),
      };
    },
    async playInVoice(guild, songs) {
      if (!connected || busy) return false;
      played.push(songs);
      playing = true;
      return true;
    },
    stopMusic() {
      const wasPlaying = playing;
      playing = false;
      return wasPlaying;
    },
  };
}

const musicChunk = (bytes = 'SONGBYTES') => [audioChunk(Buffer.from(bytes).toString('base64'))];

async function generate(message, bytes = 'CLIPBYTES') {
  return withFetch(
    async () => sseResponse(musicChunk(bytes)),
    () => musicTools.execute(null, message, 'generate_music', { prompt: 'a jingle' }, OWNER),
  );
}

function seedSong(guildId, title, { ownerId, createdBy = ownerId, bytes = 'AUDIO', length = 'short' } = {}) {
  return db.addSong(guildId, {
    title, prompt: `a song called ${title}`, data: Buffer.from(bytes),
    mediaType: 'audio/mpeg', length, costUsd: 0.04, ownerId, createdBy,
  });
}

// -- access ------------------------------------------------------------------

test('the bot owner may always generate music, with no special roles', withDb(async () => {
  assert.equal(await musicTools.allowed(fakeMessage(OWNER), OWNER), true);
  assert.equal(await musicTools.accessFor(fakeMessage(OWNER), OWNER), 'curate');
}));

test('Discord Administrator (which the server owner always has) is enough, at the curator tier', withDb(async () => {
  const message = fakeMessage('someone-else', { flags: [PermissionsBitField.Flags.Administrator] });
  assert.equal(await musicTools.accessFor(message, OWNER), 'curate');
}));

test('with no music roles mapped, a plain member gets nothing', withDb(async () => {
  const message = fakeMessage('someone-else', { flags: [PermissionsBitField.Flags.KickMembers] });
  assert.equal(await musicTools.accessFor(message, OWNER), 'none');
  assert.equal(await musicTools.allowed(message, OWNER), false);
}));

test('a role in music_roles grants generate; a role in music_curator_roles grants curate', withDb(async () => {
  db.setSetting('1', 'music_roles', ['dj']);
  db.setSetting('1', 'music_curator_roles', ['resident']);

  const dj = fakeMessage('m1', { roleIds: ['dj'] });
  assert.equal(await musicTools.accessFor(dj, OWNER), 'generate');

  const resident = fakeMessage('m2', { roleIds: ['resident'] });
  assert.equal(await musicTools.accessFor(resident, OWNER), 'curate');

  const nobody = fakeMessage('m3', { roleIds: ['random'] });
  assert.equal(await musicTools.accessFor(nobody, OWNER), 'none');
}));

test('someone who is not a member of this guild at all gets nothing', withDb(async () => {
  const message = fakeMessage('someone-else', { inGuild: false });
  assert.equal(await musicTools.accessFor(message, OWNER), 'none');
}));

// -- execute gating --------------------------------------------------------

test('execute re-checks access and refuses a non-member without calling the API', withDb(async () => {
  let calls = 0;
  await withFetch(
    async () => { calls += 1; return sseResponse(musicChunk()); },
    async () => {
      const message = fakeMessage('someone-else');
      const result = await musicTools.execute(null, message, 'generate_music', { prompt: 'a jingle' }, OWNER);
      assert.match(result, /^Error:/);
      assert.match(result, /limited to roles the server has granted/);
      assert.equal(calls, 0, 'a refused call must not reach the API');
      assert.equal(message._sent.length, 0);
    },
  );
}));

test('a member with a music role can generate', withDb(async () => {
  db.setSetting('1', 'music_roles', ['dj']);
  const message = fakeMessage('m1', { roleIds: ['dj'] });
  const result = await generate(message);
  assert.doesNotMatch(result, /^Error:/);
  assert.equal(message._sent.length, 2, 'the working notice, then the file');
}));

// -- generate_music --------------------------------------------------------

test('generate_music posts the file and reports it as already posted', withDb(async () => {
  const message = fakeMessage(OWNER);
  const result = await generate(message, 'SONGBYTES');
  assert.equal(message._sent.length, 2);
  const [file] = message._sent[1].files;
  assert.equal(file.attachment.toString(), 'SONGBYTES');
  assert.equal(file.name, 'generated_song.mp3');
  assert.match(result, /ALREADY POSTED/);
  assert.equal(message._deleted.length, 1, 'the working notice is cleaned up');
}));

test('an oversized track is not posted, and the result says so', withDb(async () => {
  const huge = Buffer.alloc(10 * 1024 * 1024 + 1, 0x41).toString('base64');
  await withFetch(
    async () => sseResponse([audioChunk(huge)]),
    async () => {
      const message = fakeMessage(OWNER);
      const result = await musicTools.execute(null, message, 'generate_music', { prompt: 'a jingle' }, OWNER);
      assert.equal(message._sent.length, 1, 'only the working notice, nothing uploaded');
      assert.match(result, /nothing was posted/);
      assert.match(result, /^Error:/);
    },
  );
}));

test('a MusicError comes back as an Error string instead of throwing', withDb(async () => {
  await withFetch(
    async () => errorResponse({ error: { message: 'model overloaded' } }, 429),
    async () => {
      const result = await musicTools.execute(null, fakeMessage(OWNER), 'generate_music', { prompt: 'a jingle' }, OWNER);
      assert.match(result, /^Error: /);
      assert.match(result, /model overloaded/);
    },
  );
}));

test('a blank prompt is a ToolError, surfaced as an Error string', withDb(async () => {
  const result = await musicTools.execute(null, fakeMessage(OWNER), 'generate_music', {}, OWNER);
  assert.match(result, /^Error: /);
  assert.match(result, /needs a prompt/);
}));

// -- save_song: personal vs server library --------------------------------

test('save_song refuses when nothing was generated recently', withDb(async () => {
  const result = await musicTools.execute(null, fakeMessage(OWNER), 'save_song', { title: 'X' }, OWNER);
  assert.match(result, /^Error:/);
  assert.match(result, /no recently generated song/);
}));

test('save_song needs a title', withDb(async () => {
  const message = fakeMessage(OWNER);
  await generate(message);
  const result = await musicTools.execute(null, message, 'save_song', {}, OWNER);
  assert.match(result, /^Error:/);
  assert.match(result, /needs a title/);
}));

test('save_song puts a track in the asker\'s own library by default', withDb(async () => {
  db.setSetting('1', 'music_roles', ['dj']);
  const message = fakeMessage('m1', { roleIds: ['dj'] });
  await generate(message);
  const saved = await musicTools.execute(null, message, 'save_song', { title: 'Chill Vibes' }, OWNER);
  assert.match(saved, /Saved "Chill Vibes" to their library \(1\/10\)/);
  assert.equal(db.countSongs('1', 'm1'), 1);
  assert.equal(db.countSongs('1', null), 0, 'nothing lands in the server library');
}));

test("save_song scope:'server' is refused for a generate-tier member, allowed for a curator", withDb(async () => {
  db.setSetting('1', 'music_roles', ['dj']);
  db.setSetting('1', 'music_curator_roles', ['resident']);

  const dj = fakeMessage('m1', { roleIds: ['dj'] });
  await generate(dj);
  const refused = await musicTools.execute(null, dj, 'save_song', { title: 'Nope', scope: 'server' }, OWNER);
  assert.match(refused, /^Error:/);
  assert.match(refused, /only music curators/);
  assert.equal(db.countSongs('1', null), 0);

  const resident = fakeMessage('m2', { roleIds: ['resident'] });
  await generate(resident);
  const ok = await musicTools.execute(null, resident, 'save_song', { title: 'House Anthem', scope: 'server' }, OWNER);
  assert.match(ok, /Saved "House Anthem" to the server library \(1\/30\)/);
  assert.equal(db.countSongs('1', null), 1);
}));

test('save_song a second time without a fresh generation fails — no silent duplicate', withDb(async () => {
  const message = fakeMessage(OWNER);
  await generate(message);
  await musicTools.execute(null, message, 'save_song', { title: 'First' }, OWNER);
  const result = await musicTools.execute(null, message, 'save_song', { title: 'Second' }, OWNER);
  assert.match(result, /^Error:/);
  assert.equal(db.countSongs('1', OWNER), 1);
}));

test('save_song refuses once the personal library is full and names the titles', withDb(async () => {
  const message = fakeMessage(OWNER);
  for (let i = 0; i < db.SONG_LIBRARY_CAP; i += 1) {
    seedSong('1', `Song ${i}`, { ownerId: OWNER });
  }
  await generate(message);
  const result = await musicTools.execute(null, message, 'save_song', { title: 'One Too Many' }, OWNER);
  assert.match(result, /^Error:/);
  assert.match(result, /full \(10\/10\)/);
  assert.match(result, /Song 0/);
  assert.equal(db.countSongs('1', OWNER), db.SONG_LIBRARY_CAP);
}));

// -- list_songs -----------------------------------------------------------

test('list_songs reports an empty state plainly', withDb(async () => {
  const result = await musicTools.execute(null, fakeMessage(OWNER), 'list_songs', {}, OWNER);
  assert.match(result, /Nothing is saved yet/);
}));

test('list_songs shows the asker\'s own library and the server library, labelled', withDb(async () => {
  seedSong('1', 'My Track', { ownerId: OWNER });
  seedSong('1', 'House Track', { ownerId: null, createdBy: OWNER });
  const result = await musicTools.execute(null, fakeMessage(OWNER), 'list_songs', {}, OWNER);
  assert.match(result, /My Track \(clip, your library\)/);
  assert.match(result, /House Track \(clip, server library\)/);
}));

test('list_songs in voice also shows a present member\'s shared library', withDb(async () => {
  seedSong('1', 'Mine', { ownerId: OWNER });
  seedSong('1', 'Friends Track', { ownerId: 'friend' });
  musicTools._setVoiceModuleForTests(fakeVoice({ members: [{ id: OWNER }, { id: 'friend', shareable: true }] }));
  try {
    const result = await musicTools.execute(null, fakeMessage(OWNER), 'list_songs', {}, OWNER);
    assert.match(result, /Friends Track/);
    assert.match(result, /shared libraries of people here/);
  } finally {
    musicTools._setVoiceModuleForTests(null);
  }
}));

test('list_songs does NOT show a present member who has not opted into sharing', withDb(async () => {
  seedSong('1', 'Mine', { ownerId: OWNER });
  seedSong('1', 'Private Track', { ownerId: 'friend' });
  musicTools._setVoiceModuleForTests(fakeVoice({ members: [{ id: OWNER }, { id: 'friend', shareable: false }] }));
  try {
    const result = await musicTools.execute(null, fakeMessage(OWNER), 'list_songs', {}, OWNER);
    assert.doesNotMatch(result, /Private Track/);
  } finally {
    musicTools._setVoiceModuleForTests(null);
  }
}));

// -- delete_song --------------------------------------------------------------

test('delete_song removes a song from the asker\'s own library', withDb(async () => {
  seedSong('1', 'Chill Vibes', { ownerId: OWNER });
  const result = await musicTools.execute(null, fakeMessage(OWNER), 'delete_song', { song: 'chill vibes' }, OWNER);
  assert.match(result, /Deleted "Chill Vibes" from their library/);
  assert.equal(db.countSongs('1', OWNER), 0);
}));

test('a generate-tier member cannot delete from the server library', withDb(async () => {
  db.setSetting('1', 'music_roles', ['dj']);
  seedSong('1', 'House Anthem', { ownerId: null, createdBy: 'someone' });
  const message = fakeMessage('m1', { roleIds: ['dj'] });
  const result = await musicTools.execute(null, message, 'delete_song', { song: 'House Anthem' }, OWNER);
  assert.match(result, /^Error:/);
  assert.equal(db.countSongs('1', null), 1);
}));

test('a curator can delete from the server library', withDb(async () => {
  db.setSetting('1', 'music_curator_roles', ['resident']);
  seedSong('1', 'House Anthem', { ownerId: null, createdBy: 'someone' });
  const message = fakeMessage('m2', { roleIds: ['resident'] });
  const result = await musicTools.execute(null, message, 'delete_song', { song: 'House Anthem' }, OWNER);
  assert.match(result, /Deleted "House Anthem" from the server library/);
  assert.equal(db.countSongs('1', null), 0);
}));

test('delete_song reports an unmatched title without deleting anything', withDb(async () => {
  seedSong('1', 'Chill Vibes', { ownerId: OWNER });
  const result = await musicTools.execute(null, fakeMessage(OWNER), 'delete_song', { song: 'nope' }, OWNER);
  assert.match(result, /^Error:/);
  assert.equal(db.countSongs('1', OWNER), 1);
}));

// -- playback ---------------------------------------------------------------

test('play_song with no name plays the just-generated clip, not a saved one', withDb(async () => {
  const voice = fakeVoice();
  musicTools._setVoiceModuleForTests(voice);
  try {
    const message = fakeMessage(OWNER);
    await generate(message, 'CLIPBYTES');
    const result = await musicTools.execute(null, message, 'play_song', {}, OWNER);
    assert.match(result, /Now playing/);
    assert.equal(voice.played[0][0].data.toString(), 'CLIPBYTES');
  } finally {
    musicTools._setVoiceModuleForTests(null);
  }
}));

test('play_song with no name and nothing generated is a clear error', withDb(async () => {
  musicTools._setVoiceModuleForTests(fakeVoice());
  try {
    const result = await musicTools.execute(null, fakeMessage(OWNER), 'play_song', {}, OWNER);
    assert.match(result, /^Error:/);
    assert.match(result, /nothing was generated recently/);
  } finally {
    musicTools._setVoiceModuleForTests(null);
  }
}));

test('play_song by title reaches the server library and a present shared library', withDb(async () => {
  seedSong('1', 'House Anthem', { ownerId: null, createdBy: 'x', bytes: 'SERVERBYTES' });
  seedSong('1', 'Friend Jam', { ownerId: 'friend', bytes: 'FRIENDBYTES' });
  const voice = fakeVoice({ members: [{ id: OWNER }, { id: 'friend', shareable: true }] });
  musicTools._setVoiceModuleForTests(voice);
  try {
    let result = await musicTools.execute(null, fakeMessage(OWNER), 'play_song', { song: 'House Anthem' }, OWNER);
    assert.match(result, /Now playing "House Anthem"/);
    assert.equal(voice.played[0][0].data.toString(), 'SERVERBYTES');

    result = await musicTools.execute(null, fakeMessage(OWNER), 'play_song', { song: 'Friend Jam' }, OWNER);
    assert.match(result, /Now playing "Friend Jam"/);
    assert.equal(voice.played[1][0].data.toString(), 'FRIENDBYTES');
  } finally {
    musicTools._setVoiceModuleForTests(null);
  }
}));

test('play_song will not reach a non-present member\'s library', withDb(async () => {
  seedSong('1', 'Stranger Song', { ownerId: 'stranger' });
  db.setMusicShareable('1', 'stranger', true); // shareable, but not in the channel
  const voice = fakeVoice({ members: [{ id: OWNER }] });
  musicTools._setVoiceModuleForTests(voice);
  try {
    const result = await musicTools.execute(null, fakeMessage(OWNER), 'play_song', { song: 'Stranger Song' }, OWNER);
    assert.match(result, /^Error:/);
    assert.match(result, /no single song matches/);
  } finally {
    musicTools._setVoiceModuleForTests(null);
  }
}));

test('play_song reports plainly when the bot is not connected to voice', withDb(async () => {
  seedSong('1', 'Chill Vibes', { ownerId: OWNER });
  musicTools._setVoiceModuleForTests(fakeVoice({ connected: false }));
  try {
    const result = await musicTools.execute(null, fakeMessage(OWNER), 'play_song', { song: 'Chill Vibes' }, OWNER);
    assert.match(result, /^Error:/);
    assert.match(result, /not in a voice channel/);
  } finally {
    musicTools._setVoiceModuleForTests(null);
  }
}));

test("play_playlist scope:'mine' plays only the asker's library, in order", withDb(async () => {
  seedSong('1', 'First', { ownerId: OWNER, bytes: 'a' });
  seedSong('1', 'Second', { ownerId: OWNER, bytes: 'b' });
  seedSong('1', 'ServerOne', { ownerId: null, createdBy: 'x', bytes: 'c' });
  const voice = fakeVoice();
  musicTools._setVoiceModuleForTests(voice);
  try {
    const result = await musicTools.execute(null, fakeMessage(OWNER), 'play_playlist', { scope: 'mine' }, OWNER);
    assert.match(result, /2 song\(s\), starting with "First"/);
    assert.deepEqual(voice.played[0].map((s) => s.title), ['First', 'Second']);
  } finally {
    musicTools._setVoiceModuleForTests(null);
  }
}));

test("play_playlist scope:'all' includes the server library and present shared libraries", withDb(async () => {
  seedSong('1', 'Mine', { ownerId: OWNER, bytes: 'a' });
  seedSong('1', 'Server', { ownerId: null, createdBy: 'x', bytes: 'b' });
  seedSong('1', 'FriendJam', { ownerId: 'friend', bytes: 'c' });
  const voice = fakeVoice({ members: [{ id: OWNER }, { id: 'friend', shareable: true }] });
  musicTools._setVoiceModuleForTests(voice);
  try {
    const result = await musicTools.execute(null, fakeMessage(OWNER), 'play_playlist', {}, OWNER);
    assert.match(result, /3 song\(s\)/);
    assert.deepEqual(voice.played[0].map((s) => s.title).sort(), ['FriendJam', 'Mine', 'Server']);
  } finally {
    musicTools._setVoiceModuleForTests(null);
  }
}));

test('play_playlist refuses when there is nothing to play', withDb(async () => {
  musicTools._setVoiceModuleForTests(fakeVoice());
  try {
    const result = await musicTools.execute(null, fakeMessage(OWNER), 'play_playlist', { scope: 'mine' }, OWNER);
    assert.match(result, /^Error:/);
    assert.match(result, /library is empty/);
  } finally {
    musicTools._setVoiceModuleForTests(null);
  }
}));

test('stop_music reports whether anything was actually stopped', withDb(async () => {
  const voice = fakeVoice();
  musicTools._setVoiceModuleForTests(voice);
  try {
    const nothing = await musicTools.execute(null, fakeMessage(OWNER), 'stop_music', {}, OWNER);
    assert.equal(nothing, 'Nothing was playing.');

    seedSong('1', 'Chill Vibes', { ownerId: OWNER });
    await musicTools.execute(null, fakeMessage(OWNER), 'play_song', { song: 'Chill Vibes' }, OWNER);
    const stopped = await musicTools.execute(null, fakeMessage(OWNER), 'stop_music', {}, OWNER);
    assert.equal(stopped, 'Stopped the music.');
  } finally {
    musicTools._setVoiceModuleForTests(null);
  }
}));

// -- sharing + access tools -----------------------------------------------

test('set_music_shareable toggles the asker\'s own music_prefs row', withDb(async () => {
  db.setSetting('1', 'music_roles', ['dj']);
  const message = fakeMessage('m1', { roleIds: ['dj'] });
  let result = await musicTools.execute(null, message, 'set_music_shareable', { shareable: true }, OWNER);
  assert.match(result, /shareable now/);
  assert.equal(db.isMusicShareable('1', 'm1'), true);

  result = await musicTools.execute(null, message, 'set_music_shareable', { shareable: false }, OWNER);
  assert.match(result, /private again/);
  assert.equal(db.isMusicShareable('1', 'm1'), false);
}));

test('set_music_access adds and removes a role from a tier — admins only', withDb(async () => {
  const admin = fakeMessage('a1', { flags: [PermissionsBitField.Flags.Administrator] });
  let result = await musicTools.execute(null, admin, 'set_music_access', { tier: 'generate', role_id: 'dj' }, OWNER);
  assert.match(result, /Granted music access/);
  assert.deepEqual(db.getSetting('1', 'music_roles'), ['dj']);

  result = await musicTools.execute(null, admin, 'set_music_access', { tier: 'generate', role_id: 'dj', revoke: true }, OWNER);
  assert.match(result, /Revoked music access/);
  assert.deepEqual(db.getSetting('1', 'music_roles'), []);
}));

test('set_music_access is refused for a music-curator role that is not a real admin', withDb(async () => {
  db.setSetting('1', 'music_curator_roles', ['resident']);
  const resident = fakeMessage('m2', { roleIds: ['resident'] });
  const result = await musicTools.execute(null, resident, 'set_music_access', { tier: 'generate', role_id: 'dj' }, OWNER);
  assert.match(result, /^Error:/);
  assert.match(result, /limited to server admins/);
  assert.deepEqual(db.getSetting('1', 'music_roles'), []);
}));

test('library tools are refused for someone with no music access', withDb(async () => {
  const message = fakeMessage('someone-else');
  const result = await musicTools.execute(null, message, 'list_songs', {}, OWNER);
  assert.match(result, /^Error:/);
  assert.match(result, /limited to roles the server has granted/);
}));
