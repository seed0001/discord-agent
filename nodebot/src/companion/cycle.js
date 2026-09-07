// The residence presence ticker: ties companion/drives.js's pure pressure
// engine to an actual live voice connection, a short in-character line
// posted into the room's text channel when she actually moves, and real
// (not deferred) image/music hobby generation during relax time.
// Guild-scoped — runs once per tick for every guild that has
// companion_residence_mode on.
import * as db from '../db.js';
import * as drivesMod from './drives.js';
import * as stateMod from './state.js';
import * as events from './events.js';
import * as session from './session.js';
import * as voice from '../voice.js';
import * as media from '../media.js';
import * as music from '../music.js';
import * as credits from '../credits/index.js';
import { musicKind } from '../credits/rates.js';
import { uploadLimit } from '../mediaTools.js';
import { chat, OpenRouterError } from '../openrouter.js';
import { buildSystemPrompt } from '../systemPrompt.js';
import { botName } from '../botName.js';

const TICK_EVERY_MS = 5 * 60 * 1000; // matches autonomous.js's reflection cadence
const ARRIVAL_MAX_TOKENS = 60;
const HOBBY_PROMPT_MAX_TOKENS = 120;
// Most relax-phase ticks do nothing — same "not a vending machine" idea as
// autonomous.js's own RUN_CHANCE for the (now-retired) deferred lottery.
const HOBBY_RUN_CHANCE = 0.15;
const HOBBY_CATEGORIES = ['image', 'music'];

// A generic, in-character-neutral fallback for when the arrival-line call
// fails or comes back empty — same convention as session.js's FALLBACK_OPENER
// and invite.js's FALLBACK_DM (never silently skip the line, never crash the
// tick over it).
const fallbackArrival = (roomName) => `heading to ${roomName}.`;

/** mediaType -> file extension. Small and local, same "not worth a shared
 *  util" precedent as videomaker.js's own extensionFor. */
function extensionFor(mediaType, fallback) {
  const type = String(mediaType || '').split(';')[0].trim().toLowerCase();
  const map = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
  };
  return map[type] || fallback;
}

// guildId -> { phase, roomId } — which room THIS ticker currently believes
// it holds the live voice connection for. In-memory only, same
// no-restart-durability tradeoff session.js's own sessions map already
// accepts: a restart costs at most one tick before she resettles, nothing
// is lost (the drive VALUES themselves are the real persisted state, in
// companion_drives — see drives.js).
const currentRoom = new Map();

/** Pick a room for this phase, avoiding an immediate repeat when there's a
 *  choice — the same "some variety, not the exact same room every time"
 *  idea as any of this codebase's other pick-one-of-several spots. */
function pickRoom(rooms, avoidId) {
  const pool = rooms.length > 1 ? rooms.filter((r) => r.id !== avoidId) : rooms;
  const options = pool.length ? pool : rooms;
  return options[Math.floor(Math.random() * options.length)];
}

/** One background (utility-model) chat() call: her persona/capabilities as
 *  usual, plus a short instruction to react to just having moved. Nobody is
 *  necessarily listening live, unlike session.js's draftOpener or invite.js's
 *  draftInvite (both real-conversational-model calls specifically because a
 *  person is there) — hence background:true here. */
async function draftArrivalLine(client, guild, room) {
  const name = botName(client, guild.id);
  const systemPrompt = `${buildSystemPrompt({ client, guild, owner: false, memory: '' })}\n\n`
    + `You (${name}) just moved to ${room.name}. Say one short in-character line reacting to `
    + 'being there now — natural, like a passing thought, not an announcement. One sentence, no '
    + 'markdown, nothing before or after it.';
  try {
    const reply = await chat([{ role: 'system', content: systemPrompt }], {
      guildId: guild.id, background: true, maxTokens: ARRIVAL_MAX_TOKENS,
    });
    return (reply || '').trim() || fallbackArrival(room.name);
  } catch (err) {
    if (err instanceof OpenRouterError) {
      console.warn(`[COMPANION] cycle arrival line failed guild=${guild.id}:`, err.message);
      return fallbackArrival(room.name);
    }
    throw err;
  }
}

/** One background call asking her to write her OWN generation prompt for
 *  something she feels like making — mirrors MEDIA_NOTE/MUSIC_NOTE's "write
 *  the prompt yourself" instruction, just self-directed instead of answering
 *  a request. Returns null (skip this round) rather than a hallucinated
 *  prompt if the call fails or comes back empty. */
async function draftHobbyPrompt(client, guild, category, room) {
  const name = botName(client, guild.id);
  const ask = category === 'image'
    ? 'a detailed IMAGE generation prompt (subject, style, composition, lighting)'
    : 'a MUSIC generation prompt (genre, mood, instruments, tempo, whether it has vocals)';
  const systemPrompt = `${buildSystemPrompt({ client, guild, owner: false, memory: '' })}\n\n`
    + `You (${name}) are relaxing in ${room.name} and feel like making something just for `
    + `yourself — nobody asked for this. Respond with ONLY ${ask}, nothing else: no preamble, `
    + 'no quotes, no explanation.';
  try {
    const reply = await chat([{ role: 'system', content: systemPrompt }], {
      guildId: guild.id, background: true, maxTokens: HOBBY_PROMPT_MAX_TOKENS,
    });
    return (reply || '').trim() || null;
  } catch (err) {
    if (err instanceof OpenRouterError) {
      console.warn(`[COMPANION] cycle hobby prompt failed guild=${guild.id}:`, err.message);
      return null;
    }
    throw err;
  }
}

/** Relax-phase-only, throttled autonomous creation — the real version of
 *  what autonomous.js's old deferred lottery only ever logged intent for.
 *  Posts straight into the room's own text channel, same as a live
 *  generate_image/generate_music tool call would. Never throws — a failure
 *  here is a skipped hobby round, not a crashed tick. */
async function maybeRunHobbyAct(client, guild, userId, room) {
  if (!room.text_channel_id) return; // nowhere to post it
  if (Math.random() > HOBBY_RUN_CHANCE) return;

  const categories = HOBBY_CATEGORIES.filter((c) => db.getSetting(guild.id, `companion_autonomous_${c}`));
  if (!categories.length) return;
  const category = categories[Math.floor(Math.random() * categories.length)];

  const channel = guild.channels.cache.get(room.text_channel_id);
  if (!channel) return;

  const prompt = await draftHobbyPrompt(client, guild, category, room);
  if (!prompt) return;

  try {
    if (category === 'image') {
      // mediaTools.js's own generate_image tool handler does not credit-gate
      // image generation either — mirrored here rather than "fixed", since
      // that asymmetry (vs. music, below) is the existing, deliberate shape
      // of the real tool this is standing in for.
      const { images } = await media.generateImage(prompt, {
        model: db.getSetting(guild.id, 'media_image_model') || undefined,
      });
      const image = images[0];
      if (!image || image.data.length > uploadLimit(guild)) {
        console.warn(`[COMPANION] cycle hobby: image missing or too large guild=${guild.id}`);
        return;
      }
      await channel.send({ files: [{ attachment: image.data, name: `hobby.${extensionFor(image.mediaType, 'png')}` }] });
    } else {
      let ctx;
      try {
        ctx = credits.gate(guild.id);
      } catch (err) {
        if (err instanceof credits.InsufficientCreditsError) {
          console.log(`[COMPANION] cycle hobby: out of credits, skipping music guild=${guild.id}`);
          return;
        }
        throw err;
      }
      const clip = await music.generateMusic(prompt, { length: 'short' });
      credits.meter(ctx, {
        kind: musicKind('short'), quantity: 1, meta: { length: 'short', costUsd: clip.costUsd ?? null, by: 'autonomous' },
      });
      if (clip.data.length > uploadLimit(guild)) {
        console.warn(`[COMPANION] cycle hobby: music clip too large guild=${guild.id}`);
        return;
      }
      await channel.send({ files: [{ attachment: clip.data, name: `hobby.${extensionFor(clip.mediaType, 'mp3')}` }] });
    }
  } catch (err) {
    console.error(`[COMPANION] cycle hobby act (${category}) failed guild=${guild.id}:`, err.message);
    return;
  }

  events.record(guild.id, userId, 'autonomous_project_completed', { category });
  let state = stateMod.load(guild.id, userId);
  state = stateMod.applyEvent(state, 'autonomous_project_completed', {}, stateMod.nowSeconds());
  stateMod.save(guild.id, userId, state);
  console.log(`[COMPANION] cycle: hobby act completed category=${category} guild=${guild.id}`);
}

async function tickGuild(client, guild) {
  if (!db.getSetting(guild.id, 'companion_residence_mode')) return;
  if (!db.getSetting(guild.id, 'companion_enabled')) return;
  const primaryUserId = db.getSetting(guild.id, 'companion_primary_user_id');
  if (!session.isIdle(guild.id)) return; // never touch voice mid-conversation

  const drives = drivesMod.load(guild.id);
  drivesMod.save(guild.id, drives);

  const key = String(guild.id);
  const held = currentRoom.get(key);

  if (drives.phase === 'sleep') {
    if (held) {
      try {
        voice.leaveRequestedGuild(guild);
      } catch (err) {
        console.error('[COMPANION] cycle leave-on-sleep failed:', err.message);
      }
      currentRoom.delete(key);
      console.log(`[COMPANION] cycle: asleep, left voice guild=${guild.id}`);
    }
    return;
  }

  const rooms = db.listCompanionRooms(guild.id, drives.phase);
  if (!rooms.length) {
    console.log(`[COMPANION] cycle: no rooms registered for phase=${drives.phase} guild=${guild.id}`);
    return;
  }

  // settledRoom is whichever room she's confirmed to be in by the end of
  // this tick — already there, or just moved — so the hobby act below
  // always has a real room to work with either way.
  let settledRoom = null;

  // Already correctly placed for this phase — no churn every 5 minutes.
  if (held && held.phase === drives.phase && rooms.some((r) => r.id === held.roomId)) {
    settledRoom = rooms.find((r) => r.id === held.roomId);
  } else {
    const room = pickRoom(rooms, held?.roomId);
    const channel = guild.channels.cache.get(room.voice_channel_id);
    if (!channel) {
      console.warn(`[COMPANION] cycle: room #${room.id} "${room.name}" voice channel missing guild=${guild.id}`);
      return;
    }

    const result = await voice.wakeGuild(guild, channel);
    if (!result.joined) {
      console.warn(`[COMPANION] cycle: failed to join room #${room.id} "${room.name}" guild=${guild.id} `
        + `reason=${result.reason || 'unknown'}`);
      return;
    }
    currentRoom.set(key, { phase: drives.phase, roomId: room.id });
    console.log(`[COMPANION] cycle: moved to room #${room.id} "${room.name}" phase=${drives.phase} guild=${guild.id}`);

    if (room.text_channel_id) {
      const textChannel = guild.channels.cache.get(room.text_channel_id);
      if (textChannel) {
        const line = await draftArrivalLine(client, guild, room);
        await textChannel.send(line).catch((err) => console.warn('[COMPANION] cycle arrival post failed:', err.message));
      }
    }
    settledRoom = room;
  }

  if (drives.phase === 'relax' && primaryUserId && settledRoom) {
    await maybeRunHobbyAct(client, guild, primaryUserId, settledRoom);
  }
}

async function tick(client) {
  for (const guild of client.guilds.cache.values()) {
    // eslint-disable-next-line no-await-in-loop
    await tickGuild(client, guild).catch((err) => console.error(`[COMPANION] cycle tick failed for guild ${guild.id}:`, err.message));
  }
}

let ticker = null;

export function startTicker(client) {
  if (ticker) return;
  ticker = setInterval(() => tick(client), TICK_EVERY_MS);
  ticker.unref?.();
}

export function stopTicker() {
  if (ticker) clearInterval(ticker);
  ticker = null;
}

/** Test seam. */
export function _resetForTests() {
  currentRoom.clear();
}
