// Drafts and sends the voice-session invitation: a short DM (text + a
// generated voice clip) inviting the primary companion user into the
// Private Companion Room. Deliberately does not touch relationship state —
// scheduler.js owns state.js writes; this module only communicates and
// reports what happened.
import * as db from '../db.js';
import * as tts from '../tts.js';
import { chat } from '../openrouter.js';
import { botName } from '../botName.js';
import * as events from './events.js';
import * as memory from '../memory.js';
import { formatForPrompt } from '../conversation.js';
import { buildSystemPrompt } from '../systemPrompt.js';
import { isOwner } from '../utils.js';

const INVITE_HISTORY_TURNS = 40;

function parseInviteReply(text) {
  const dmMatch = /^DM:\s*(.+)$/im.exec(text);
  const spokenMatch = /^SPOKEN:\s*(.+)$/im.exec(text);
  const dm = (dmMatch ? dmMatch[1] : text).trim();
  const spoken = (spokenMatch ? spokenMatch[1] : dm).trim();
  return { dm, spoken };
}

// A generic, in-character-neutral fallback for the rare case the model
// returns nothing usable at all (empty, or garbage that parses to empty)
// even on the real conversational model — better than either sending an
// empty Discord message (which Discord rejects outright) or silently
// dropping the invite.
const FALLBACK_DM = "hey — got a minute to hop into voice? I'd like to actually talk.";

// How many times to re-roll if the draft comes back as a near-repeat of the
// last invite actually sent — see draftInvite's isRepeat check below. Kept
// small: this is a real message a person reads, not silent housekeeping, so
// it shouldn't balloon into a long retry chain over one repeated phrase.
const REPEAT_RETRIES = 2;

/** Loose equality for "did she just say this again" — case/whitespace/
 *  trailing-punctuation insensitive, since "Got a sec to talk?" and
 *  "got a sec to talk" are the same repeat even though they don't match
 *  byte-for-byte. */
function normalize(text) {
  return (text || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!?]+$/, '');
}

function isRepeat(dm, lastInviteText) {
  return Boolean(lastInviteText) && normalize(dm) === normalize(lastInviteText);
}

/** One LLM call: the character's existing persona + the compact context
 *  packet + the pre-selected intent, asking for a short DM line and a short
 *  spoken line. Deliberately NOT `background: true` — that routes through
 *  OPENROUTER_UTILITY_MODEL, a cheap/free tier meant for silent internal
 *  housekeeping (classification, memory consolidation) where an occasional
 *  garbage or empty reply is harmless. This is a real message a person
 *  reads; it gets the same model as an ordinary conversational reply.
 *  Already gates/meters credits internally (chat()).
 *
 *  `lastInviteText` — the DM actually sent last time (state.js's
 *  lastInviteText, threaded through from scheduler.js) — is handed back to
 *  the model both as an instruction ("don't repeat this") and, on a re-roll,
 *  as a concrete example of what just happened, since a generic "be varied"
 *  instruction alone was landing on the same stock phrase whenever the
 *  underlying context (nothing new since the last invite) hadn't changed. */
async function draftInvite(client, guild, member, packetText, lastInviteText) {
  const name = botName(client, guild.id);
  const model = db.getSetting(guild.id, 'ai_model');
  const owner = isOwner(member.id);
  const transcript = formatForPrompt(guild.id, INVITE_HISTORY_TURNS);

  const basePrompt = buildSystemPrompt({
    client, guild, owner, memory: memory.getContext(guild.id, member.id),
  }) + `\n\nYou are ${name}. You are about to reach out to a member you have an ongoing `
    + 'relationship with, inviting them into a private voice conversation. This is not a normal chat '
    + `reply — write ONLY the invitation, nothing else. Base it on what you actually remember and on `
    + `the recent conversation below — do not act like you are meeting them for the first time.\n\n${packetText}\n\n`
    + 'Write two short lines, exactly in this format:\n'
    + 'DM: <one or two sentences, natural text-message tone, inviting them to hop into voice with you>\n'
    + 'SPOKEN: <a short spoken version of the same invitation, natural to say out loud>\n'
    + 'No markdown, nothing before or after those two lines.'
    + (lastInviteText
      ? `\n\nThe last thing you said reaching out to them, which they haven't responded to, was: `
        + `"${lastInviteText}"\nDo not repeat that verbatim or say essentially the same thing again — `
        + 'find a different angle, even if the underlying reason for reaching out is similar.'
      : '');

  const userContent = transcript ? `[recent conversation]\n${transcript}` : '[no recent conversation on record]';

  for (let attempt = 0; attempt <= REPEAT_RETRIES; attempt += 1) {
    const systemPrompt = attempt === 0 ? basePrompt : `${basePrompt}\n\nThat repeated your last message — try `
      + 'genuinely different wording and framing this time, not just a synonym swap.';
    // eslint-disable-next-line no-await-in-loop
    const reply = await chat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ], { guildId: guild.id, model, maxTokens: 200 });
    const { dm, spoken } = parseInviteReply(reply || '');
    if (dm && !isRepeat(dm, lastInviteText)) return { dm, spoken: spoken || dm };
    if (dm) console.log(`[COMPANION] invite draft repeated the last message — re-rolling (${attempt + 1}/${REPEAT_RETRIES})`);
  }
  console.warn('[COMPANION] invite draft came back empty or kept repeating — using the fallback line');
  return { dm: FALLBACK_DM, spoken: FALLBACK_DM };
}

/**
 * Draft + send the invitation DM. Returns `{ ok: true, spoken, dm }` on
 * success (the spoken line doubles as the opening line once conversation
 * starts — no second LLM call needed; `dm` is returned so the caller can
 * remember it as next time's "don't repeat this" reference — see state.js's
 * lastInviteText) or `{ ok: false }` if the DM could not be delivered (DMs
 * closed, etc). A failed delivery records `dm_delivery_failed` — a distinct
 * event from an ignored invite, since nothing was actually offered to the
 * user — and the caller must not proceed to joining the room.
 */
export async function send(client, guild, member, packetText, lastInviteText = null) {
  const { dm, spoken } = await draftInvite(client, guild, member, packetText, lastInviteText);

  let audio = null;
  try {
    audio = await tts.synthesize(spoken, { guildId: guild.id });
  } catch (err) {
    console.error('[COMPANION] invite TTS failed, sending DM without a voice clip:', err.message);
  }

  try {
    const payload = { content: dm.slice(0, 2000), allowedMentions: { parse: [] } };
    if (audio) payload.files = [{ attachment: audio, name: 'invite.mp3' }];
    await member.send(payload);
  } catch (err) {
    console.error(`[COMPANION] invite DM to ${member.id} failed:`, err.message);
    events.record(guild.id, member.id, 'dm_delivery_failed', { reason: err.message });
    return { ok: false };
  }

  return { ok: true, spoken, dm };
}
