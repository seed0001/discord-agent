// The bot's name, in one place.
//
// It used to be the literal string 'Max' scattered across voice.js,
// proactive.js, deescalate.js and systemPrompt.js. Renaming the bot in
// Discord therefore renamed it *almost* everywhere: text chat already used
// client.user.username, so after a rename the same bot appeared in the shared
// conversation buffer under two different speaker names — the model would see
// "Amy" say one thing and "Max" say another and treat them as two people.
//
// Resolution order, most specific first:
//   1. the per-guild `bot_name` setting, when an admin has typed one
//   2. the live Discord application's display name / username
//   3. a neutral fallback, so a half-connected client never writes "undefined"
//
// (2) is the default and the one to prefer: rename the application in the
// Discord developer portal and everything here follows on the next boot with
// nothing to configure. (1) exists for servers that want to call it something
// else without renaming the application globally.
import * as db from './db.js';
import { normalizePhrase, expandPhraseTemplates } from './phrases.js';
import {
  VOICE_WAKE_WORDS, VOICE_CANCEL_WORDS,
  VOICE_STOP_SPEAKING_WORDS, VOICE_STOP_LISTENING_WORDS, VOICE_LEAVE_WORDS,
  VOICE_PHRASES_FROM_ENV,
} from './config.js';

/** Used only when there is no override and no connected client. */
export const BOT_NAME_FALLBACK = 'the bot';

/**
 * @param {object} client   discord.js Client (or anything with .user)
 * @param {string|number} [guildId]  guild whose override to honour
 * @returns {string} the bot's name as it should be shown and spoken
 */
export function botName(client, guildId = null) {
  if (guildId !== null && guildId !== undefined) {
    let override;
    try {
      override = db.getSetting(guildId, 'bot_name');
    } catch {
      // Database not open yet (early boot, or a unit test that never called
      // initDb). The Discord name below is still perfectly good.
      override = null;
    }
    if (typeof override === 'string' && override.trim()) return override.trim();
  }
  return client?.user?.displayName || client?.user?.username || BOT_NAME_FALLBACK;
}

/** The same name, normalized for phrase matching ('Amy 🤖' -> 'amy'). */
export function botNameForPhrases(client, guildId = null) {
  return normalizePhrase(botName(client, guildId));
}

// Name-derived defaults for the voice phrase lists. The shipped defaults were
// written around "max" ("max stop speaking", "hey max"), which is useless the
// moment the bot is called something else — the stop words simply never fire.
const DERIVE = {
  voice_wake_words: (n) => [`hey ${n}`, `${n} are you there`],
  // Deliberately not derived: "never mind" / "forget it" work whatever the
  // bot is called, and no name belongs in them.
  voice_cancel_words: null,
  voice_stop_speaking_words: (n) => [
    `${n} stop speaking`, `${n} stop talking`, `stop speaking ${n}`,
    `stop talking ${n}`, `${n} be quiet`, `${n} shut up`, `${n} quiet down`,
  ],
  voice_stop_listening_words: (n) => [
    `${n} stop listening`, `stop listening ${n}`,
    `${n} we are done`, `${n} that is all`, `thanks ${n} that is all`,
  ],
  voice_leave_words: (n) => [
    `${n} go to sleep`, `go to sleep ${n}`, `${n} leave voice`,
    `${n} leave the voice channel`, `${n} leave the call`,
    `${n} you can go now`, `${n} drop from voice`,
  ],
};

const ENV_DEFAULTS = {
  voice_wake_words: VOICE_WAKE_WORDS,
  voice_cancel_words: VOICE_CANCEL_WORDS,
  voice_stop_speaking_words: VOICE_STOP_SPEAKING_WORDS,
  voice_stop_listening_words: VOICE_STOP_LISTENING_WORDS,
  voice_leave_words: VOICE_LEAVE_WORDS,
};

/**
 * Resolve one voice phrase list, honouring in order:
 *   1. a value this guild actually saved from the dashboard
 *   2. an explicitly configured environment variable
 *   3. phrases derived from the bot's current name
 *
 * (1) beating (3) is the important one: deriving over the top of a saved list
 * would silently rewrite wake words an admin deliberately chose.
 */
export function voicePhrases(client, guildId, key) {
  const name = botNameForPhrases(client, guildId);
  let list;
  if (db.hasSetting(guildId, key)) list = db.getSetting(guildId, key);
  else if (VOICE_PHRASES_FROM_ENV[key]) list = ENV_DEFAULTS[key];
  else {
    const derive = DERIVE[key];
    // A name that normalizes away entirely (all emoji, say) would derive
    // nonsense like "hey " — keep the shipped default rather than break voice.
    if (!derive || !name) list = ENV_DEFAULTS[key];
    else list = derive(name);
  }
  const expanded = expandPhraseTemplates(list, name);
  // Everything in the list was an {ai} template and the name expanded to
  // nothing, so it was all dropped. Same call as above: keep the shipped
  // default rather than leave the guild with no wake words at all.
  //
  // Only when there was something to lose. A list someone explicitly emptied
  // stays empty — that is a deliberate "no wake words here", not a failure to
  // expand, and re-deriving over it would ignore what they asked for.
  if (list.length && !expanded.length) return ENV_DEFAULTS[key];
  return expanded;
}
