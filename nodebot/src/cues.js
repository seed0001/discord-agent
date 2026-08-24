// What the bot plays to signal what it is doing, per guild.
//
// Three moments are worth signalling, and they are worth signalling because
// smart detection made the bot's silence ambiguous in a way wake words never
// were:
//
//   thinking  — your name came up and the bot is deciding whether that was
//               for it. This is the gap that used to be instant.
//   engaging  — it decided yes and is about to talk.
//   declined  — it decided the conversation was merely ABOUT it, and is
//               staying quiet. Without this, "it ignored me" and "it decided
//               not to butt in" sound exactly alike, and people repeat
//               themselves at a bot that already made a decision.
//
// A fourth moment lives outside that trio:
//
//   stopped_listening — the follow-up window (see voice.js's followUp state)
//               just closed, whether it timed out or someone said the words.
//               Without this, "is he still listening right now" is a guess.
//
// Each can be a synthesized tone (earcon.js — always available), a sound from
// the server's own Discord soundboard, or nothing.
import { botName } from './botName.js';
import { playEarcon, EARCONS } from './earcon.js';
import * as db from './db.js';

/** Settings keys, in the order the dashboard shows them. */
export const CUE_EVENTS = ['thinking', 'engaging', 'declined', 'stopped_listening'];

export const cueSettingKey = (event) => `voice_cue_${event}`;

/** Guilds we've already complained about, so a missing permission logs once
 *  rather than on every single detection. */
const warned = new Set();

/** Normalize whatever is stored into a shape the player can act on.
 *
 * Tolerant on purpose: this is read on a hot path, and a half-written value
 * from a hand-edited database or an older release must degrade to a tone
 * rather than throw inside the voice pipeline. */
export function parseCue(value) {
  if (value == null) return { mode: 'off' };
  if (typeof value === 'string') {
    // Legacy/simple form: "tone", "off", or "sound:<id>".
    if (value === 'off' || value === '') return { mode: 'off' };
    if (value.startsWith('sound:')) {
      const [, soundId, soundGuildId] = value.split(':');
      return soundId ? { mode: 'soundboard', soundId, soundGuildId } : { mode: 'tone' };
    }
    return { mode: 'tone' };
  }
  if (typeof value !== 'object') return { mode: 'tone' };
  if (value.mode === 'off') return { mode: 'off' };
  if (value.mode === 'soundboard') {
    if (!value.soundId) return { mode: 'tone' };  // configured but unusable
    return {
      mode: 'soundboard',
      soundId: String(value.soundId),
      soundGuildId: value.soundGuildId ? String(value.soundGuildId) : undefined,
    };
  }
  return { mode: 'tone' };
}

export function cueFor(guildId, event) {
  try {
    return parseCue(db.getSetting(guildId, cueSettingKey(event)));
  } catch {
    return { mode: 'off' };
  }
}

/**
 * Play the cue configured for `event`.
 *
 * @param {object} guild
 * @param {object} channel  the voice channel the bot is sitting in
 * @param {string} event    one of CUE_EVENTS
 * @param {object} [deps]   injection seam for tests
 * @returns {Promise<'tone'|'soundboard'|'off'|'failed'>} what actually happened
 */
export async function playCue(guild, channel, event, deps = {}) {
  const cue = deps.cue || cueFor(guild.id, event);
  if (cue.mode === 'off') return 'off';
  if (db.getSetting(guild.id, 'quiet_mode')) return 'off';

  if (cue.mode === 'soundboard' && typeof channel?.sendSoundboardSound === 'function') {
    try {
      await channel.sendSoundboardSound({
        soundId: cue.soundId,
        // Discord needs the owning guild only for sounds from ELSEWHERE, and
        // those additionally require Use External Sounds. Passing the current
        // guild's own id is harmless.
        guildId: cue.soundGuildId ?? guild.id,
      });
      return 'soundboard';
    } catch (err) {
      // Deleted sound, missing Use Soundboard / Speak, or a sound from
      // another guild without the external permission. Fall through to a
      // tone: a misconfigured soundboard should degrade to a quieter signal,
      // not to silence, because silence is the thing cues exist to fix.
      if (!warned.has(guild.id)) {
        warned.add(guild.id);
        console.warn(`[cues] soundboard playback failed in ${botName(guild.client, guild.id)}'s `
          + `guild ${guild.id} — falling back to a tone: ${err?.message || err}`);
      }
    }
  }

  // The players map has to reach playEarcon: it is the same map voice.js uses
  // to tell whether the bot is mid-sentence. Building a second, private player
  // here would let a tone play straight over the bot's own speech.
  const played = await playEarcon(guild, event, { players: deps.players, ...(deps.earcon || {}) });
  return played ? 'tone' : 'failed';
}

/** The tone kinds that exist, for validating dashboard input. */
export const TONE_KINDS = Object.keys(EARCONS);

/** Test seam. */
export function resetWarnings() {
  warned.clear();
}
