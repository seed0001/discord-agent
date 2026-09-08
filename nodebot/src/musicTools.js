// Music generation and the song library, exposed to the AI as tools. music.js
// does the actual OpenRouter/Lyria call; this file decides who is allowed to
// spend money on it, meters what they spend, and manages the libraries the
// results get kept in.
//
// Two things changed when music opened up beyond server admins:
//
//  1. ACCESS is a per-server role mapping (music_roles / music_curator_roles),
//     resolved in musicRoles.js. Admins and the server owner always get the
//     top tier; with both lists empty music stays admin-only, which is the
//     historical behaviour and a safe default because every generation costs
//     real money.
//
//  2. LIBRARIES are per-owner. Each member keeps a personal library
//     (SONG_LIBRARY_CAP songs); curators can also add to one shared server
//     library (SERVER_LIBRARY_CAP). In voice, a member who has opted their
//     library into sharing (set_music_shareable) lets other people in the
//     same channel play their saved songs — but only while they are actually
//     in the channel; nothing is copied.
//
// Handlers take (client, message, args, access) with the same relaxed
// `message` contract mediaTools uses — only .guild/.channel/.author/.member
// are touched — so voice.js's plain stand-in object works as well as a real
// Message.
import { PermissionsBitField } from 'discord.js';
import * as db from './db.js';
import * as music from './music.js';
import * as videomaker from './videomaker.js';
import * as credits from './credits/index.js';
import { musicKind } from './credits/rates.js';
import {
  musicAccess, canGenerateMusic, canCurateMusic,
} from './musicRoles.js';
import { resolveLevel, memberFacts, levelAtLeast } from './web/roles.js';
import { OWNER_ID } from './config.js';
import {
  uploadLimit, tooLarge, postedNote, allowed as mediaAllowed, takeVideoSlot,
} from './mediaTools.js';
import { audioMediaType, readAttachment, MAX_AUDIO_BYTES } from './documents.js';

export class ToolError extends Error {}

function str(description) {
  return { type: 'string', description };
}

function schema(name, description, properties = {}, required = []) {
  return {
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties, required } },
  };
}

// -- access ----------------------------------------------------------------

async function resolveMember(message) {
  const { guild } = message;
  let member = message.member || guild.members.cache.get(String(message.author.id));
  if (!member) {
    try {
      member = await guild.members.fetch(String(message.author.id));
    } catch {
      return null; // not a member of this guild
    }
  }
  return member;
}

/** The dashboard access level for this message's author — needed for the
 *  handful of things (editing the music role lists) that a music-curator role
 *  alone must not unlock. */
async function dashboardLevelFor(message, ownerId = OWNER_ID) {
  const member = await resolveMember(message);
  if (!member) return 'none';
  return resolveLevel({
    ...memberFacts(member, PermissionsBitField),
    ownerId,
    adminRoles: db.getSetting(message.guild.id, 'dashboard_admin_roles') || [],
    modRoles: db.getSetting(message.guild.id, 'dashboard_mod_roles') || [],
  });
}

/** 'none' | 'generate' | 'curate' — what this message's author may do with
 *  music on this server. */
export async function accessFor(message, ownerId = OWNER_ID) {
  const member = await resolveMember(message);
  if (!member) return 'none';
  const facts = memberFacts(member, PermissionsBitField);
  const dashboardLevel = resolveLevel({
    ...facts,
    ownerId,
    adminRoles: db.getSetting(message.guild.id, 'dashboard_admin_roles') || [],
    modRoles: db.getSetting(message.guild.id, 'dashboard_mod_roles') || [],
  });
  return musicAccess({
    dashboardLevel,
    roleIds: facts.roleIds,
    roles: db.getSetting(message.guild.id, 'music_roles') || [],
    curatorRoles: db.getSetting(message.guild.id, 'music_curator_roles') || [],
  });
}

/** May this message's author generate music at all? Kept as the boolean the
 *  system-prompt assembly and the schema gating in textChat.js / voice.js
 *  ask for. ownerId is an injectable override for testing. */
export async function allowed(message, ownerId = OWNER_ID) {
  return canGenerateMusic(await accessFor(message, ownerId));
}

// -- voice playback bridge ---------------------------------------------------
// The actual AudioPlayer/connection machinery lives in voice.js, which
// already imports this file statically — so this file can't import voice.js
// back at load time without a cycle. Resolved lazily instead, and swappable
// here for tests.
let voiceModule = null;
async function getVoice() {
  if (!voiceModule) voiceModule = await import('./voice.js');
  return voiceModule;
}
/** Test seam: point playback calls at a fake instead of the real voice.js. */
export function _setVoiceModuleForTests(mod) { voiceModule = mod; }

/** Test seam: drop the "song I just made / just uploaded" cache. */
export function _resetForTests() { pendingClips.clear(); }

// -- "the song I just made, or just uploaded" --------------------------------
// Neither a generated clip nor an uploaded attachment is saved automatically
// — that's a decision someone makes after hearing it. generateSong and
// noteUploadedAudio both stash the raw clip here, keyed by guild AND user
// (two people acting in one server must not clobber each other's take), and
// save_song / play_song with no song named reach for it. The TTL keeps a
// save_song called long after the fact from silently persisting a stale,
// forgotten take.
const LAST_SONG_TTL_MS = 15 * 60 * 1000;
// `${guildId}:${userId}` -> { kind: 'generated'|'upload', data, mediaType,
//   prompt, length, costUsd, filename, at }
const pendingClips = new Map();

const pendingKey = (guildId, userId) => `${guildId}:${userId}`;

function pendingSong(guildId, userId) {
  const entry = pendingClips.get(pendingKey(guildId, userId));
  if (!entry || Date.now() - entry.at > LAST_SONG_TTL_MS) return null;
  return entry;
}

function clearPending(guildId, userId) {
  pendingClips.delete(pendingKey(guildId, userId));
}

/** A member can paste a song straight into chat instead of generating one.
 * Downloads the first audio attachment on this message (if any) and stashes
 * it as their pending clip, same slot generateSong uses — so save_song or
 * play_song works on it immediately, or on a later message while it's still
 * fresh. Returns a note to fold into the model's context (what was attached,
 * or why it couldn't be used), or '' when the message has no audio attached.
 * Never throws — a bad download shouldn't take down message handling. */
export async function noteUploadedAudio(message) {
  const attachments = [...(message.attachments?.values?.() ?? message.attachments ?? [])];
  const attachment = attachments.find((a) => audioMediaType(a));
  if (!attachment) {
    // Not silent when there WERE attachments but none read as audio — this is
    // exactly the case someone reports as "I attached it and he didn't see
    // it," and without this line there's no way to tell a real miss (wrong
    // contentType, an extension we don't recognise) from a text-only message.
    if (attachments.length) {
      const described = attachments.map((a) => `${a.name || a.filename || '?'} (${a.contentType || a.content_type || 'no contentType'})`).join(', ');
      console.warn('[musicTools] message had attachment(s) but none read as audio:', described);
    }
    return '';
  }
  const filename = attachment.name || attachment.filename || 'audio file';
  if (attachment.size > MAX_AUDIO_BYTES) {
    return `[${filename} is ${Math.floor(attachment.size / 1024)}KB — too large to save to the music `
      + `library (max ${Math.floor(MAX_AUDIO_BYTES / (1024 * 1024))}MB)]`;
  }
  let data;
  try {
    data = await readAttachment(attachment);
  } catch (err) {
    console.warn('[musicTools] could not download uploaded audio:', err?.message || err);
    return `[Couldn't download ${filename}]`;
  }
  pendingClips.set(pendingKey(message.guild.id, message.author.id), {
    kind: 'upload', data, mediaType: audioMediaType(attachment), filename, at: Date.now(),
  });
  return `[attached audio: ${filename} — call save_song with a title to add it to the music library, `
    + 'or play_song to play it now]';
}

// -- library scope helpers --------------------------------------------------

/** The user ids of people in the bot's current voice channel who have opted
 *  their library into sharing — excluding the caller. [] off the voice path
 *  or when the bot isn't connected. */
async function presentShareableOwners(message, uid) {
  try {
    const voice = await getVoice();
    const channel = voice.currentVoiceChannel?.(message.guild);
    const members = channel?.members;
    if (!members) return [];
    const present = [...members.values()]
      .filter((m) => !m.user?.bot && String(m.id) !== String(uid))
      .map((m) => String(m.id));
    return db.shareableUserIds(message.guild.id, present);
  } catch {
    return [];
  }
}

/** Every library the caller may play from right now: their own, the server
 *  library, and any shared libraries of people currently in voice with them. */
async function playableScope(message) {
  const uid = String(message.author.id);
  return [uid, null, ...(await presentShareableOwners(message, uid))];
}

/** A compact snapshot of what music is available to play right now, for the
 *  voice system prompt — so the bot can offer to put something on without
 *  having to call list_songs first. Titles only (cheap); '' when there's
 *  nothing saved anywhere in reach. */
export async function voiceMusicContext(message) {
  const guildId = message.guild.id;
  const uid = String(message.author.id);
  const titles = (rows, max = 8) => rows.slice(0, max).map((r) => r.title).join(', ')
    + (rows.length > max ? `, +${rows.length - max} more` : '');

  const lines = [];
  const server = db.listSongs(guildId, null);
  if (server.length) lines.push(`Server library: ${titles(server)}`);

  const mine = db.listSongs(guildId, uid);
  if (mine.length) lines.push(`${message.member?.displayName || 'their'} library: ${titles(mine)}`);

  try {
    const voice = await getVoice();
    const members = voice.currentVoiceChannel?.(message.guild)?.members;
    if (members) {
      const present = [...members.values()]
        .filter((m) => !m.user?.bot && String(m.id) !== uid).map((m) => String(m.id));
      for (const ownerId of db.shareableUserIds(guildId, present)) {
        const rows = db.listSongs(guildId, ownerId);
        if (!rows.length) continue;
        const name = message.guild?.members?.cache?.get(ownerId)?.displayName || 'someone here';
        lines.push(`${name}'s shared library: ${titles(rows)}`);
      }
    }
  } catch { /* not connected / voice not loaded */ }

  if (!lines.length) return '';
  return '\nMUSIC AVAILABLE HERE (play_song by title, or play_playlist):\n- '
    + `${lines.join('\n- ')}`;
}

function ownerLabel(message, ownerId, uid) {
  if (ownerId === null || ownerId === undefined) return 'server library';
  if (String(ownerId) === String(uid)) return 'your library';
  const name = message.guild?.members?.cache?.get(String(ownerId))?.displayName;
  return name ? `${name}'s library` : 'a shared library';
}

// -- handlers -----------------------------------------------------------------

async function generateSong(client, message, args) {
  const prompt = String(args.prompt || '').trim();
  if (!prompt) throw new ToolError('generate_music needs a prompt.');
  const length = args.length === 'full' ? 'full' : 'short';

  // Credit gate first — music.js goes straight to OpenRouter over fetch, not
  // through openrouter.js's chat(), so it doesn't inherit that gate.
  let ctx;
  try {
    ctx = credits.gate(message.guild.id);
  } catch (err) {
    if (err instanceof credits.InsufficientCreditsError) {
      throw new ToolError('this server is out of credits, so I can’t generate music right now — '
        + 'whoever manages it can top the balance up from the dashboard.');
    }
    throw err;
  }

  let notice = null;
  try {
    notice = await message.channel.send(length === 'full'
      ? 'Writing a song — this can take a minute or two.'
      : 'Writing a quick track — one sec.');
  } catch (err) {
    console.warn('[musicTools] could not post the music notice:', err.message);
  }

  try {
    let clip;
    try {
      clip = await music.generateMusic(prompt, { length });
    } catch (err) {
      if (err instanceof music.MusicError) throw new ToolError(err.message);
      throw err;
    }

    // Metered whether or not the take is kept — the spend already happened.
    credits.meter(ctx, {
      kind: musicKind(length),
      quantity: 1,
      meta: { length, costUsd: clip.costUsd ?? null, by: String(message.author.id) },
    });

    pendingClips.set(pendingKey(message.guild.id, message.author.id), {
      kind: 'generated', data: clip.data, mediaType: clip.mediaType, prompt, length, costUsd: clip.costUsd, at: Date.now(),
    });

    const limit = uploadLimit(message.guild);
    if (clip.data.length > limit) {
      return tooLarge(clip.data.length, limit, 'ask for a shorter track — a clip instead of a full song');
    }
    await message.channel.send({ files: [{ attachment: clip.data, name: 'generated_song.mp3' }] });
    const cost = clip.costUsd
      ? ` It cost $${clip.costUsd.toFixed(4)} to make (you may mention this if asked).`
      : '';
    return `${postedNote(1, 'track')}${cost} Ask them if they want it saved to their library before calling save_song.`;
  } finally {
    if (notice) {
      await notice.delete().catch(() => { /* already gone, or no permission */ });
    }
  }
}

// -- song library handlers ----------------------------------------------------

function libraryLine(row, i, message, uid) {
  const kind = row.length === 'full' ? 'full song' : row.length === 'upload' ? 'uploaded track' : 'clip';
  const where = ownerLabel(message, row.owner_id, uid);
  return `${i + 1}. ${row.title} (${kind}, ${where})`;
}

async function saveSong(client, message, args, access) {
  const title = String(args.title || '').trim();
  if (!title) throw new ToolError('save_song needs a title for the song.');
  const toServer = String(args.scope || '').toLowerCase() === 'server';
  if (toServer && !canCurateMusic(access)) {
    throw new ToolError('only music curators, server admins or the server owner can add to the server '
      + 'library. Saving to their own library instead is fine.');
  }
  const pending = pendingSong(message.guild.id, message.author.id);
  if (!pending) {
    throw new ToolError('there is no recently generated or uploaded song to save — call generate_music '
      + 'first, or attach an audio file, then call save_song right after, while it is still fresh.');
  }
  const ownerId = toServer ? null : String(message.author.id);
  const cap = db.libraryCap(ownerId);
  const count = db.countSongs(message.guild.id, ownerId);
  if (count >= cap) {
    const titles = db.listSongs(message.guild.id, ownerId).map((r) => r.title).join(', ');
    throw new ToolError(`the ${toServer ? 'server' : "user's"} library is full (${cap}/${cap}): ${titles}. `
      + 'Ask which one to remove, call delete_song with it, then call save_song again.');
  }
  db.addSong(message.guild.id, {
    title,
    prompt: pending.kind === 'upload' ? `[uploaded: ${pending.filename}]` : pending.prompt,
    data: pending.data,
    mediaType: pending.mediaType,
    length: pending.kind === 'upload' ? 'upload' : pending.length,
    costUsd: pending.costUsd ?? null,
    ownerId,
    createdBy: message.author.id,
  });
  clearPending(message.guild.id, message.author.id);
  return `Saved "${title}" to ${toServer ? 'the server library' : 'their library'} (${count + 1}/${cap}).`;
}

async function listSongsHandler(client, message) {
  const uid = String(message.author.id);
  const sharedOwners = await presentShareableOwners(message, uid);
  const scope = [uid, null, ...sharedOwners];
  const rows = db.listSongs(message.guild.id, scope);
  if (!rows.length) {
    return 'Nothing is saved yet — their library, the server library and any shared libraries here are all empty.';
  }
  const mineCount = rows.filter((r) => String(r.owner_id) === uid).length;
  const serverCount = rows.filter((r) => r.owner_id === null).length;
  const header = `Songs you can play (${rows.length}) — `
    + `${mineCount}/${db.SONG_LIBRARY_CAP} in their library, ${serverCount}/${db.SERVER_LIBRARY_CAP} in the server library`
    + (sharedOwners.length ? `, plus shared libraries of people here` : '');
  return `${header}:\n${rows.map((r, i) => libraryLine(r, i, message, uid)).join('\n')}`;
}

async function deleteSongHandler(client, message, args, access) {
  const query = String(args.song || '').trim();
  if (!query) throw new ToolError('delete_song needs the title (or list number) of the song to remove.');
  const uid = String(message.author.id);
  // A member can delete from their own library; a curator can also prune the
  // server library. Nobody deletes from someone else's personal library.
  const scope = canCurateMusic(access) ? [uid, null] : [uid];
  const row = db.findSong(message.guild.id, query, scope);
  if (!row) {
    throw new ToolError(`no song you can delete matches "${query}" — you can only remove songs from `
      + `${canCurateMusic(access) ? 'their own library or the server library' : 'their own library'}. `
      + 'Use list_songs for exact titles.');
  }
  db.deleteSong(message.guild.id, row.id);
  return `Deleted "${row.title}" from ${row.owner_id === null ? 'the server library' : 'their library'}.`;
}

async function playSongHandler(client, message, args) {
  const query = String(args.song || '').trim();
  let song;
  if (!query) {
    const pending = pendingSong(message.guild.id, message.author.id);
    if (!pending) {
      throw new ToolError('no song was named and nothing was generated recently — name a saved song, '
        + 'or call generate_music first.');
    }
    song = { title: 'the song I just made', data: pending.data, mediaType: pending.mediaType };
  } else {
    const row = db.findSong(message.guild.id, query, await playableScope(message));
    if (!row) {
      throw new ToolError(`no single song matches "${query}" in their library, the server library, or the `
        + 'shared libraries of people here — use list_songs to see the exact titles.');
    }
    song = db.getSongData(message.guild.id, row.id);
  }
  const voice = await getVoice();
  const started = await voice.playInVoice(message.guild, [song]);
  if (!started) {
    throw new ToolError("I'm not in a voice channel here, or something is already playing — "
      + 'say stop_music first if something is already going.');
  }
  return `Now playing "${song.title}" in voice.`;
}

async function playPlaylistHandler(client, message, args) {
  const uid = String(message.author.id);
  const wanted = String(args.scope || 'all').toLowerCase();
  let owners;
  if (wanted === 'mine') owners = [uid];
  else if (wanted === 'server') owners = [null];
  else owners = [uid, null, ...(await presentShareableOwners(message, uid))];

  const rows = db.listSongs(message.guild.id, owners);
  if (!rows.length) {
    throw new ToolError(wanted === 'mine'
      ? 'their library is empty — save a song first with save_song.'
      : 'there are no saved songs to play — save some first with save_song.');
  }
  const songs = rows.map((r) => db.getSongData(message.guild.id, r.id)).filter(Boolean);
  const voice = await getVoice();
  const started = await voice.playInVoice(message.guild, songs);
  if (!started) {
    throw new ToolError("I'm not in a voice channel here, or something is already playing — "
      + 'say stop_music first if something is already going.');
  }
  return `Started the playlist — ${songs.length} song(s), starting with "${songs[0].title}".`;
}

// -- music videos -------------------------------------------------------------

const MUSIC_VIDEO_STAGE_LABELS = {
  script: 'Planning the shot list',
  images: 'Illustrating scenes',
  animate: 'Animating scenes',
  slicing: 'Cutting the song into scenes',
  assemble: 'Rendering the final video',
};

function musicVideoStatusLine(info) {
  const label = MUSIC_VIDEO_STAGE_LABELS[info.stage] || info.stage;
  const pct = Math.round((info.progress || 0) * 100);
  const cost = info.costUsd ? ` — $${info.costUsd.toFixed(4)} so far` : '';
  return `Generating music video: ${label} (${pct}%)${cost}`;
}

async function generateMusicVideoHandler(client, message, args, access, ownerId) {
  if (!(await mediaAllowed(message, ownerId))) {
    throw new ToolError('image and video generation is disabled in this server, or limited to the bot '
      + 'owner — a music video needs both music access and media/video access.');
  }
  const guildId = message.guild.id;
  takeVideoSlot(guildId, Number(db.getSetting(guildId, 'media_video_hourly_cap')) || 0);

  const query = String(args.song || '').trim();
  let song;
  if (query) {
    const row = db.findSong(guildId, query, await playableScope(message));
    if (!row) {
      throw new ToolError(`no single song matches "${query}" in their library, the server library, or `
        + 'the shared libraries of people here — use list_songs for exact titles.');
    }
    song = db.getSongForVideo(guildId, row.id);
  } else {
    const pending = pendingSong(guildId, message.author.id);
    if (!pending) {
      throw new ToolError('no song was named and nothing was generated recently — name a saved song, '
        + 'or call generate_music first.');
    }
    song = {
      title: 'the song I just made', data: pending.data, mediaType: pending.mediaType, prompt: pending.prompt,
    };
  }
  if (!song?.prompt || /^\[uploaded:/.test(song.prompt)) {
    throw new ToolError('music videos only work for songs Max generated himself, since that is how he '
      + 'knows the lyrics and style to illustrate — not uploaded audio. Call generate_music first.');
  }

  let notice = null;
  try {
    notice = await message.channel.send('Starting the music video: planning the shot list — this '
      + "typically takes a few minutes, I'll keep this updated.");
  } catch (err) {
    console.warn('[musicTools] could not post the music video notice:', err.message);
  }
  const updateNotice = async (info) => {
    if (!notice) return;
    try {
      await notice.edit(musicVideoStatusLine(info));
    } catch (err) {
      console.warn('[musicTools] could not update the music video notice:', err.message);
    }
  };

  try {
    let clip;
    try {
      clip = await videomaker.createMusicVideo(song, {
        notes: args.notes,
        imageModel: db.getSetting(guildId, 'media_image_model') || undefined,
        animate: Boolean(db.getSetting(guildId, 'media_video_animate')),
        animationModel: db.getSetting(guildId, 'media_video_animation_model') || undefined,
        onStatus: updateNotice,
      });
    } catch (err) {
      if (err instanceof videomaker.VideoMakerError) throw new ToolError(err.message);
      throw err;
    }

    const limit = uploadLimit(message.guild);
    if (clip.data.length > limit) {
      return tooLarge(clip.data.length, limit, 'ask for a shorter song, or a video with fewer scenes');
    }
    const filename = String(clip.title || song.title || 'music_video')
      .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'music_video';
    await message.channel.send({ files: [{ attachment: clip.data, name: `${filename}.mp4` }] });
    const cost = clip.costUsd
      ? ` It cost $${clip.costUsd.toFixed(4)} to make (illustrations via OpenRouter — you may mention `
        + 'this if asked).'
      : '';
    return `${postedNote(1, 'music video')}${cost}`;
  } finally {
    if (notice) {
      await notice.delete().catch(() => { /* already gone, or no permission */ });
    }
  }
}

async function stopMusicHandler(client, message) {
  const voice = await getVoice();
  const stopped = voice.stopMusic(message.guild);
  return stopped ? 'Stopped the music.' : 'Nothing was playing.';
}

function truthy(value) {
  if (value === true) return true;
  return ['1', 'true', 'yes', 'on', 'share', 'shareable'].includes(String(value).toLowerCase());
}

async function setShareableHandler(client, message, args) {
  const on = truthy(args.shareable);
  db.setMusicShareable(message.guild.id, message.author.id, on);
  return on
    ? 'Their library is shareable now — while they are in the voice channel, other people in it can ask '
      + 'me to play their saved songs. Nothing is copied.'
    : 'Their library is private again — only they can play their own saved songs.';
}

async function setAccessHandler(client, message, args) {
  const level = dashboardLevelForCache.get(message); // set by execute() before dispatch
  if (!levelAtLeast(level || 'none', 'admin')) {
    throw new ToolError('changing who can use music is limited to server admins and the server owner.');
  }
  const tier = String(args.tier || '').toLowerCase();
  if (!['generate', 'curator'].includes(tier)) {
    throw new ToolError("tier must be 'generate' (make music + personal library) or 'curator' (also the server library).");
  }
  const key = tier === 'curator' ? 'music_curator_roles' : 'music_roles';
  const current = new Set((db.getSetting(message.guild.id, key) || []).map(String));
  const roleId = String(args.role_id || '').trim();
  if (!roleId) throw new ToolError('give the Discord role id to grant or revoke.');
  const revoke = truthy(args.revoke);
  if (revoke) current.delete(roleId);
  else current.add(roleId);
  db.setSetting(message.guild.id, key, [...current]);
  const roleName = message.guild?.roles?.cache?.get(roleId)?.name || roleId;
  return `${revoke ? 'Revoked' : 'Granted'} ${tier === 'curator' ? 'server-library' : 'music'} access `
    + `${revoke ? 'from' : 'to'} the ${roleName} role.`;
}

// execute() stashes the caller's dashboard level here so setAccessHandler can
// reach it without re-resolving; cleared right after dispatch.
const dashboardLevelForCache = new WeakMap();

// -- registry ---------------------------------------------------------------

export const TOOLS = {
  generate_music: [schema('generate_music',
    'Compose a piece of music and post it in the channel, once you actually know what to make. '
    + 'Do NOT call this the first time someone asks for a song — ask 2-4 quick questions first '
    + '(genre/style, mood or energy, key instruments or whether it should have vocals and lyrics, '
    + 'and whether they want a short ~30-second clip to try an idea or a longer full song) unless '
    + 'they already gave you enough of that unprompted. Write the actual prompt yourself from what '
    + 'they told you rather than forwarding their words verbatim. Every generation costs the server '
    + 'credits whether or not the result is kept.',
    {
      prompt: str('The full music prompt: genre/style, mood, instruments, tempo, structure '
        + '(intro/verse/chorus/etc, mainly useful for a full song), and lyrics if it should have '
        + "vocals. Written specifically from what the user told you, not their wording verbatim."),
      length: str("'short' for a ~30 second clip (fast, cheap — good for trying an idea), or "
        + "'full' for a complete structured song. Default 'short' unless they asked for a full song."),
    }, ['prompt']), generateSong],

  save_song: [schema('save_song',
    'Save the most recently generated song, OR the most recently uploaded audio attachment (look for '
    + '"[attached audio: ...]" in their message), so it can be replayed later without regenerating or '
    + "re-uploading it. By default it goes to the asker's own personal library (holds "
    + `${db.SONG_LIBRARY_CAP}). Pass scope:'server' to put it in the shared server library instead `
    + `(holds ${db.SERVER_LIBRARY_CAP}) — only music curators, admins and the server owner may do `
    + 'that. Only call this after generate_music or an audio upload, and only if the user said they '
    + 'want to keep it. If the target library is full this tells you the current titles so you can ask '
    + 'which to remove.',
    {
      title: str('A short, memorable title for the song.'),
      scope: str("'personal' (default) for the asker's own library, or 'server' for the shared server library (curators only)."),
    }, ['title']), saveSong],

  list_songs: [schema('list_songs',
    "List the songs the person talking to you can play right now: their personal library, the shared "
    + 'server library, and — in voice — the shared libraries of anyone in the channel who has opted in.',
    {}, []), listSongsHandler],

  delete_song: [schema('delete_song',
    "Remove a song. A member can remove songs from their own library; a curator can also remove songs "
    + 'from the server library. Use this when someone wants an old song gone or needs to make room.',
    { song: str('The title (or list number from list_songs) of the song to remove.') }, ['song']),
  deleteSongHandler],

  play_song: [schema('play_song',
    "Play one song through the bot's current voice channel. Name a song by title — it's resolved "
    + "against the asker's library, the server library, and the shared libraries of people currently "
    + 'in the channel — or leave it blank to play whatever generate_music just made or was just '
    + 'uploaded, even if unsaved. Requires the bot to already be in a voice channel; call stop_music '
    + 'first if something is playing.',
    { song: str('The title of a song to play. Leave blank for the most recently generated/uploaded one.') }, []),
  playSongHandler],

  play_playlist: [schema('play_playlist',
    'Play several saved songs back to back through the voice channel the bot is in. scope:'
    + "'all' (default) is everything the asker can reach — their library, the server library, and "
    + "shared libraries of people here; 'server' is just the server library; 'mine' is just the "
    + "asker's own. Call stop_music first if something is already playing.",
    { scope: str("'all' (default), 'server', or 'mine'.") }, []), playPlaylistHandler],

  generate_music_video: [schema('generate_music_video',
    "Make a lyric video for a song Max generated himself: a sequence of illustrated stills, one per "
    + 'section of the song (intro/verse/chorus/etc), playing in order while the song itself plays as '
    + 'the soundtrack — there is no separate narration. Only works for songs Max wrote himself, not '
    + 'uploaded audio, since only then does he know the lyrics/style to illustrate. Takes several '
    + 'minutes and costs real money (illustrations + rendering, on top of whatever the song itself '
    + 'cost), so only call this when someone actually asks for a video of a song. Images are synced to '
    + "even time-slices across the song, not exact lyric timing — that's expected for now. Leave `song` "
    + 'blank to use whatever was just generated and is still pending.',
    {
      song: str('The title of a saved song to make a video for. Leave blank for the most recently '
        + 'generated one.'),
      notes: str('Optional extra guidance for the shot list: visual style, era, setting, mood. Leave '
        + 'blank unless the user said something beyond wanting a video.'),
    }, []), generateMusicVideoHandler],

  stop_music: [schema('stop_music',
    'Stop whatever song or playlist is playing in voice and go back to plain listening. Use it any '
    + 'time someone asks to stop the music, pause it, or wants to talk instead.',
    {}, []), stopMusicHandler],

  set_music_shareable: [schema('set_music_shareable',
    "Turn the asker's own library sharing on or off. When on, other people in the same voice channel "
    + 'can ask you to play that person\'s saved songs — but only while they are actually in the '
    + 'channel, and nothing is ever copied. Off by default. This only ever affects the person asking.',
    { shareable: str("true to allow sharing, false to make their library private again.") }, ['shareable']),
  setShareableHandler],

  set_music_access: [schema('set_music_access',
    'Grant or revoke music access for a Discord role. Server admins and the server owner only. '
    + "tier 'generate' lets a role make music and keep a personal library; tier 'curator' also lets "
    + 'them add to the shared server library. Needs the role id.',
    {
      tier: str("'generate' or 'curator'."),
      role_id: str('The Discord role id to grant or revoke.'),
      revoke: str('true to remove the role from that tier instead of adding it.'),
    }, ['tier', 'role_id']), setAccessHandler],
};

export const TOOL_SCHEMAS = Object.values(TOOLS).map(([s]) => s);

/** Run one music tool call and return its result string (never throws).
 * Re-checks access rather than trusting the caller to have filtered the
 * schemas it offered — same defence in depth as mediaTools.execute. */
export async function execute(client, message, name, args, ownerId) {
  const entry = TOOLS[name];
  if (!entry) return `Error: unknown tool '${name}'.`;

  const access = await accessFor(message, ownerId);
  if (!canGenerateMusic(access)) {
    return 'Error: music and the song library are limited to roles the server has granted music '
      + 'access, plus server admins and the server owner.';
  }

  // set_music_access needs the real dashboard level, not just music access —
  // a music-curator role must not be able to hand out more music roles.
  if (name === 'set_music_access') {
    dashboardLevelForCache.set(message, await dashboardLevelFor(message, ownerId));
  }

  try {
    return await entry[1](client, message, args || {}, access, ownerId);
  } catch (err) {
    if (err instanceof ToolError) return `Error: ${err.message}`;
    if (err instanceof music.MusicError) return `Error: ${err.message}`;
    if (err instanceof videomaker.VideoMakerError) return `Error: ${err.message}`;
    if (err instanceof credits.InsufficientCreditsError) {
      return 'Error: this server is out of credits — the balance can be topped up from the dashboard.';
    }
    if (err.code === 50013 || err.status === 403) {
      return "Error: I don't have permission to attach files in this channel.";
    }
    if (err.code === 40005) return 'Error: Discord rejected the upload as too large.';
    if (err.name === 'DiscordAPIError') return `Error: Discord API error: ${err.message}`;
    return `Error: ${name} failed (${err.message}).`;
  } finally {
    dashboardLevelForCache.delete(message);
  }
}
