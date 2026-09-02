// Real conversational DM replies — but ONLY between the bot and a guild's
// primary companion user. Discord DMs aren't guild-scoped, so the caller
// (session.js's handleDirectMessage) resolves which companion-enabled
// guild's relationship this message belongs to; the base bot otherwise
// never processes DM content as chat at all (textChat.js bails outright on
// !message.guild) — this is companion-specific, not "the bot does DMs now."
//
// She DMs the primary user first (invite.js) and, once a real relationship
// exists, DM is a natural place to keep talking — going completely silent
// on a reply reads as broken, not as "conversation only happens in voice."
import { chat, OpenRouterError } from '../openrouter.js';
import { recordTurn, formatForPrompt } from '../conversation.js';
import * as memory from '../memory.js';
import { buildSystemPrompt } from '../systemPrompt.js';
import { botName } from '../botName.js';
import { isOwner } from '../utils.js';
import * as db from '../db.js';
import * as stateMod from './state.js';
import * as events from './events.js';
import * as threadsMod from './threads.js';

const DM_HISTORY_TURNS = 40;
const CHANNEL_LABEL = 'DM';

function dmFraming(activeSession) {
  if (activeSession && activeSession.status === 'waiting') {
    return '\n\nYou just invited this person into '
      + `<#${activeSession.roomChannelId}> and are waiting there for them. This reply is happening `
      + 'in DM, not the room — keep it short, and naturally nudge them to come join you there rather '
      + 'than having the whole conversation here.';
  }
  return '\n\nThis is a private DM with your companion — a normal conversation, not the voice room.';
}

/**
 * Generate and send a real reply to a DM from the primary companion user.
 * `activeSession` is whatever companion/session.js's internal session
 * record currently holds for this guild (or undefined/null) — passed in
 * rather than imported, so this file doesn't need to import session.js
 * (which imports voice.js, which is the actual cycle risk elsewhere).
 *
 * @returns {Promise<boolean>} whether a reply was actually sent
 */
export async function respond(client, guild, member, message, activeSession) {
  if (!db.getSetting(guild.id, 'ai_enabled')) return false;
  const content = (message.content || '').trim();
  if (!content) return false;

  const guildId = guild.id;
  const owner = isOwner(member.id);
  const self = botName(client, guildId);

  recordTurn(guildId, { source: 'text', channel: CHANNEL_LABEL, speaker: member.username, text: content });
  memory.recordTurn(guildId, member.username, content, {
    source: 'text', userId: member.id, channel: CHANNEL_LABEL,
  });

  const state = stateMod.load(guildId, member.id);
  const pattern = events.summarizePattern(guildId, member.id);
  const openThreads = threadsMod.openThreads(guildId, member.id);
  const packet = stateMod.buildContextPacket(state, { pattern, threads: openThreads });

  const systemPrompt = buildSystemPrompt({
    client, guild, owner, memory: memory.getContext(guildId, member.id),
  }) + `\n\n${packet.text}${dmFraming(activeSession)}`;

  const model = db.getSetting(guildId, 'ai_model');
  const transcript = formatForPrompt(guildId, DM_HISTORY_TURNS);

  let reply;
  try {
    reply = await chat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `[private DM]\n${transcript}` },
    ], { model, guildId });
  } catch (err) {
    if (err instanceof OpenRouterError) {
      console.warn('[COMPANION] DM reply failed:', err.message);
      return false;
    }
    throw err;
  }
  if (!reply) return false;

  recordTurn(guildId, { source: 'text', channel: CHANNEL_LABEL, speaker: self, text: reply });
  memory.recordTurn(guildId, self, reply, { source: 'text', userId: null, channel: CHANNEL_LABEL });

  try {
    for (let i = 0; i < reply.length; i += 1990) {
      // eslint-disable-next-line no-await-in-loop
      await message.channel.send(reply.slice(i, i + 1990));
    }
  } catch (err) {
    console.warn('[COMPANION] posting DM reply failed:', err.message);
    return false;
  }
  return true;
}
