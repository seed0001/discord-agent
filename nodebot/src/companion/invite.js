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

function parseInviteReply(text) {
  const dmMatch = /^DM:\s*(.+)$/im.exec(text);
  const spokenMatch = /^SPOKEN:\s*(.+)$/im.exec(text);
  const dm = (dmMatch ? dmMatch[1] : text).trim();
  const spoken = (spokenMatch ? spokenMatch[1] : dm).trim();
  return { dm, spoken };
}

/** One cheap LLM call: the character's existing persona + the compact
 *  context packet + the pre-selected intent, asking for a short DM line and
 *  a short spoken line. Already gates/meters credits internally (chat()). */
async function draftInvite(client, guild, packetText) {
  const persona = db.getSetting(guild.id, 'ai_system_prompt');
  const name = botName(client, guild.id);
  const prompt = [{
    role: 'system',
    content: `${persona}\n\nYou are ${name}. You are about to reach out to a member you have an ongoing `
      + 'relationship with, inviting them into a private voice conversation. This is not a normal chat '
      + `reply — write ONLY the invitation, nothing else.\n\n${packetText}\n\n`
      + 'Write two short lines, exactly in this format:\n'
      + 'DM: <one or two sentences, natural text-message tone, inviting them to hop into voice with you>\n'
      + 'SPOKEN: <a short spoken version of the same invitation, natural to say out loud>\n'
      + 'No markdown, nothing before or after those two lines.',
  }];
  const reply = await chat(prompt, { guildId: guild.id, background: true, maxTokens: 200 });
  return parseInviteReply(reply);
}

/**
 * Draft + send the invitation DM. Returns `{ ok: true, spoken }` on success
 * (the spoken line doubles as the opening line once conversation starts —
 * no second LLM call needed) or `{ ok: false }` if the DM could not be
 * delivered (DMs closed, etc). A failed delivery records `dm_delivery_failed`
 * — a distinct event from an ignored invite, since nothing was actually
 * offered to the user — and the caller must not proceed to joining the room.
 */
export async function send(client, guild, member, packetText) {
  const { dm, spoken } = await draftInvite(client, guild, packetText);

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

  return { ok: true, spoken };
}
