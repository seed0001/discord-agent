// Lobby vetting: new members are interviewed by voice (or text, if they'd
// rather not talk) before they get full server access. Max leaves whatever
// voice channel he's in, joins the lobby, runs the interview, posts a
// recommendation for a human mod to approve/reject, then leaves — the
// existing rebalance sweep in voice.js carries him back to wherever people
// actually are. See docs/dynamic-game-engine.md for the full design.
//
// Deliberately independent of voice.js's wake-word/follow-up machinery:
// an interview isn't a "hey Max" conversation, it's the reason someone is
// in the lobby at all, so every utterance from the person being
// interviewed goes straight to handleInterviewUtterance — no wake word,
// no cooldown. voice.js calls back into this module (dynamically, to avoid
// a circular import — see the hook in handleUtterance) to make that happen;
// this module imports voice.js directly since the dependency only runs one
// way.
import {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  PermissionFlagsBits, ChannelType,
} from 'discord.js';
import * as db from './db.js';
import * as voice from './voice.js';
import { chat, OpenRouterError } from './openrouter.js';
import { InsufficientCreditsError } from './credits/index.js';
import { recordTurn, formatForPrompt } from './conversation.js';
import { botName } from './botName.js';
import { isOwner, logAction } from './utils.js';

const CONTEXT_TURNS = 40;
const MAX_TOOL_ROUNDS = 3;
// Rough speaking-rate estimate so the bot doesn't get yanked out of the
// lobby mid-goodbye — voice.js doesn't expose "wait for playback to finish"
// outside itself, so this is a deliberate approximation, not a precise wait.
const MS_PER_CHAR = 70;
const MIN_LEAVE_DELAY_MS = 3_000;
const MAX_LEAVE_DELAY_MS = 15_000;

// guildId:channelId -> session. One live interview per (guild, channel) —
// in practice one per guild, since there's one lobby voice channel.
const sessions = new Map();
// guildId -> sessionKey, so a second person joining the lobby while someone
// else is already being interviewed gets queued instead of silently ignored
// or double-booking the one voice connection a bot can hold per guild.
const activeGuild = new Map();
// guildId -> array of {member, channel} waiting their turn.
const queues = new Map();

function sessionKey(guildId, channelId) {
  return `${guildId}:${channelId}`;
}

const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'submit_vetting_recommendation',
      description: (
        "Call this once you've asked through the interview and are ready to "
        + 'wrap up — how familiar they are with tabletop RPGs, what they\'d '
        + 'be into, how they found the server and who they know, and whether '
        + "they're comfortable working with an AI throughout. This submits "
        + 'your recommendation to a human moderator, who makes the actual '
        + 'call — you are not deciding admission yourself.'
      ),
      parameters: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: 'A few sentences on who they are and why they want in.',
          },
          familiarity: {
            type: 'string',
            description: 'Their stated familiarity with tabletop RPGs / D&D-style games.',
          },
          interested_in: {
            type: 'string',
            description: 'What kind of games/settings they said they\'d be into.',
          },
          knows: {
            type: 'string',
            description: 'Who they said they know here, or how they found the server. "nobody" / "just found it" is a valid answer.',
          },
          comfortable_with_ai: {
            type: 'boolean',
            description: 'Whether they said they\'re comfortable working with an AI throughout.',
          },
          recommendation: {
            type: 'string',
            enum: ['approve', 'reject', 'unsure'],
            description: 'Your recommendation. The human mod decides either way.',
          },
          reasoning: {
            type: 'string',
            description: 'Why you\'re recommending that.',
          },
        },
        required: ['summary', 'recommendation', 'reasoning'],
      },
    },
  },
];

function interviewSystemPrompt(client, guild, targetName) {
  const name = botName(client, guild.id);
  return (
    `You're ${name}, running the front-door interview for a private, `
    + 'invite-curated Discord server before a new member gets full access. '
    + `You're talking with ${targetName}. Stay in your normal chill, `
    + 'low-key voice — this is a conversation, not a form.\n\n'

    + 'Cover these, conversationally and in whatever order fits the chat '
    + "(don't read them as a checklist):\n"
    + '1. Open by welcoming them and setting expectations: this is a pretty '
    + "chill, no-judgment server, everything's fairly open, and the server "
    + 'owner (Travis) has final say on who sticks around — you interview and '
    + "recommend, you don't decide.\n"
    + '2. How familiar are they with tabletop RPGs / D&D-style games?\n'
    + "3. What kind of games/settings would they be into?\n"
    + '4. How did they find this server, and do they know anyone here '
    + 'already?\n'
    + "5. Are they comfortable working with an AI throughout this — you're "
    + 'the DM, the mod, and the one running this interview?\n\n'

    + "Once you've genuinely covered all five, call "
    + 'submit_vetting_recommendation with what you learned. Do not let this '
    + "drag on — if the conversation has covered the ground, wrap it up. "
    + 'After the tool call, say a short, warm goodbye that makes clear a '
    + "human still has to sign off — don't tell them they're in or out "
    + 'yourself.'
  );
}

/** The one message read out loud (and posted as text, if there's a lobby
 * text channel) the moment Max joins — hardcoded rather than generated so
 * the rules get stated exactly, every time, with no round-trip needed
 * before the room hears anything. */
function openingLine(client, guild, member) {
  const name = botName(client, guild.id);
  return (
    `hey ${member.displayName}, welcome — i'm ${name}. before you get full `
    + "access here i just wanna have a quick chat: why you're here, how you "
    + "found us, that kind of thing. this is a pretty chill, no-judgment "
    + "server, everything's pretty open, and travis has the final say on who "
    + "sticks around — i just talk to folks first and pass along what i "
    + "learn. so, what brings you here?"
  );
}

export function activeInterview(guildId, channelId) {
  return sessions.get(sessionKey(guildId, channelId)) || null;
}

// -- entry points -------------------------------------------------------------

export async function handleMemberAdd(member) {
  const guild = member.guild;
  if (!db.getSetting(guild.id, 'gatekeeping_enabled')) return;

  const roleId = db.getSetting(guild.id, 'gatekeeping_unverified_role');
  if (roleId) {
    const role = guild.roles.cache.get(String(roleId));
    if (role) {
      try {
        await member.roles.add(role, 'Gatekeeping: pending vetting interview');
      } catch (err) {
        console.warn('[gatekeeping] failed to assign unverified role:', err.message);
      }
    } else {
      console.warn(`[gatekeeping] configured unverified role ${roleId} no longer exists`);
    }
  }

  const textChannelId = db.getSetting(guild.id, 'gatekeeping_lobby_text_channel');
  const voiceChannelId = db.getSetting(guild.id, 'gatekeeping_lobby_voice_channel');
  if (!textChannelId) return;
  const textChannel = guild.channels.cache.get(String(textChannelId));
  if (!textChannel) return;
  const voiceChannel = voiceChannelId ? guild.channels.cache.get(String(voiceChannelId)) : null;
  const name = botName(guild.client, guild.id);
  const hop = voiceChannel
    ? ` hop into **${voiceChannel.name}** and ${name} will come talk with you there`
    : ` reply here and ${name} will get started`;
  try {
    await textChannel.send(
      `hey ${member}, welcome! before you get full access,${hop} — or if you'd `
      + `rather not talk out loud, just say so and we'll do this in text instead.`,
    );
  } catch (err) {
    console.warn('[gatekeeping] welcome-to-lobby message failed:', err.message);
  }
}

export function handleVoiceStateUpdate(oldState, newState) {
  const member = newState.member || oldState.member;
  if (!member || member.user.bot) return;
  const guild = newState.guild || oldState.guild;
  if (!db.getSetting(guild.id, 'gatekeeping_enabled')) return;
  const lobbyId = db.getSetting(guild.id, 'gatekeeping_lobby_voice_channel');
  if (!lobbyId) return;
  if (newState.channelId !== String(lobbyId) || oldState.channelId === newState.channelId) return;

  const unverifiedId = db.getSetting(guild.id, 'gatekeeping_unverified_role');
  // No unverified role configured means every joiner counts as "pending" —
  // otherwise only people still wearing that role need the interview, so a
  // verified member sitting in the lobby channel for some other reason
  // doesn't retrigger it.
  if (unverifiedId && !member.roles.cache.has(String(unverifiedId))) return;

  const lobbyChannel = newState.channel;
  if (!lobbyChannel) return;
  startInterview(member, lobbyChannel)
    .catch((err) => console.error('[gatekeeping] startInterview failed:', err.message));
}

export async function handleLobbyText(client, message) {
  if (message.author.bot || !message.guild) return;
  const guild = message.guild;
  if (!db.getSetting(guild.id, 'gatekeeping_enabled')) return;
  const textChannelId = db.getSetting(guild.id, 'gatekeeping_lobby_text_channel');
  if (!textChannelId || message.channel.id !== String(textChannelId)) return;
  const unverifiedId = db.getSetting(guild.id, 'gatekeeping_unverified_role');
  const member = message.member;
  if (!member || (unverifiedId && !member.roles.cache.has(String(unverifiedId)))) return;

  const key = sessionKey(guild.id, message.channel.id);
  let session = sessions.get(key);
  if (!session) {
    session = {
      guild, channel: message.channel, targetUserId: member.id,
      targetName: member.displayName, voice: false, startedAt: Date.now(),
    };
    sessions.set(key, session);
    recordTurn(guild.id, {
      source: 'text', channel: message.channel.name, speaker: botName(client, guild.id),
      text: openingLine(client, guild, member),
    });
    try {
      await message.channel.send(openingLine(client, guild, member));
    } catch (err) {
      console.warn('[gatekeeping] opening line post failed:', err.message);
    }
    return; // let them answer the opener before running a model turn
  }
  if (session.targetUserId !== member.id) return; // someone else's interview
  await runInterviewTurn(session, {
    userId: member.id, name: member.displayName, text: message.content, speak: false,
  });
}

// -- voice hook, called from voice.js's handleUtterance ----------------------

export async function handleInterviewUtterance(guild, channel, userId, text) {
  const session = activeInterview(guild.id, channel.id);
  if (!session || session.targetUserId !== userId) return;
  await runInterviewTurn(session, {
    userId, name: session.targetName, text, speak: true,
  });
}

// -- the actual interview loop -------------------------------------------------

async function startInterview(member, lobbyChannel) {
  const guild = member.guild;
  const key = sessionKey(guild.id, lobbyChannel.id);
  if (sessions.has(key)) return; // already interviewing in this channel
  if (activeGuild.has(guild.id)) {
    // Max can only be in one voice channel per guild — queue rather than
    // interrupt whoever he's already talking to.
    const list = queues.get(guild.id) || [];
    if (!list.some((q) => q.member.id === member.id)) list.push({ member, channel: lobbyChannel });
    queues.set(guild.id, list);
    try {
      await lobbyChannel.send(`hang tight ${member} — i'm finishing up with someone else, i'll be right with you.`);
    } catch { /* best effort */ }
    return;
  }

  const joined = await voice.joinRequestedChannel(lobbyChannel);
  if (!joined) {
    console.warn(
      `[gatekeeping] couldn't join lobby channel #${lobbyChannel.name} — `
      + 'check voice_channel_allowlist and TRANSCRIPTION_API_KEY',
    );
    return;
  }

  const session = {
    guild, channel: lobbyChannel, targetUserId: member.id, targetName: member.displayName,
    voice: true, startedAt: Date.now(), turns: 0,
  };
  sessions.set(key, session);
  activeGuild.set(guild.id, key);

  const line = openingLine(guild.client, guild, member);
  recordTurn(guild.id, { source: 'voice', channel: lobbyChannel.name, speaker: botName(guild.client, guild.id), text: line });
  try {
    await lobbyChannel.send(line);
  } catch (err) {
    console.warn('[gatekeeping] opening line post failed:', err.message);
  }
  await voice.speakInVoice(guild, line);
}

async function runInterviewTurn(session, { userId, name, text, speak }) {
  const { guild, channel } = session;
  session.turns = (session.turns || 0) + 1;
  recordTurn(guild.id, {
    source: speak ? 'voice' : 'text', channel: channel.name, speaker: name, text,
  });

  const systemPrompt = interviewSystemPrompt(guild.client, guild, session.targetName)
    + (session.turns > 8
      ? "\n\nYou've been at this a while — wrap up with submit_vetting_recommendation now."
      : '');
  const transcript = formatForPrompt(guild.id, CONTEXT_TURNS);

  let concluded = false;
  let recommendation = null;
  const toolHandler = async (toolName, args) => {
    if (toolName !== 'submit_vetting_recommendation') return `Unknown tool: ${toolName}`;
    concluded = true;
    recommendation = args;
    await postRecommendation(session, args);
    return 'Recommendation submitted to the mods. Say a short goodbye — a human still has to approve it.';
  };

  let reply;
  try {
    reply = await chat([
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `[lobby interview transcript, #${channel.name}]\n${transcript}`,
      },
    ], {
      model: db.getSetting(guild.id, 'ai_model'),
      tools: TOOL_SCHEMAS,
      toolHandler,
      maxToolRounds: MAX_TOOL_ROUNDS,
      guildId: guild.id,
    });
  } catch (err) {
    if (err instanceof InsufficientCreditsError) return;
    console.warn('[gatekeeping] interview turn failed:', err.message);
    const apology = "sorry, having some technical trouble — hang tight, someone will get you sorted.";
    if (speak) await voice.speakInVoice(guild, apology);
    try { await channel.send(apology); } catch { /* best effort */ }
    return;
  }
  if (!reply) return;

  recordTurn(guild.id, { source: speak ? 'voice' : 'text', channel: channel.name, speaker: botName(guild.client, guild.id), text: reply });
  try {
    await channel.send(reply);
  } catch (err) {
    console.warn('[gatekeeping] reply post failed:', err.message);
  }
  if (speak) await voice.speakInVoice(guild, reply);

  if (concluded) await endInterview(session, reply, speak);
}

async function postRecommendation(session, rec) {
  const { guild } = session;
  const modChannelId = db.getSetting(guild.id, 'gatekeeping_mod_channel');
  const color = rec.recommendation === 'approve' ? 0x23A559
    : rec.recommendation === 'reject' ? 0xDA373C : 0xF0B232;
  const embed = new EmbedBuilder()
    .setTitle(`Vetting: ${session.targetName}`)
    .setColor(color)
    .addFields(
      { name: 'Summary', value: (rec.summary || '—').slice(0, 1024) },
      { name: 'RPG familiarity', value: (rec.familiarity || '—').slice(0, 1024), inline: true },
      { name: 'Interested in', value: (rec.interested_in || '—').slice(0, 1024), inline: true },
      { name: 'Says they know', value: (rec.knows || '—').slice(0, 1024), inline: true },
      { name: 'OK working with AI', value: rec.comfortable_with_ai === false ? 'No' : 'Yes', inline: true },
      { name: "Max's recommendation", value: rec.recommendation, inline: true },
      { name: 'Reasoning', value: (rec.reasoning || '—').slice(0, 1024) },
    )
    .setFooter({ text: `user id: ${session.targetUserId}` })
    .setTimestamp();
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`vet:approve:${session.targetUserId}`).setLabel('Approve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`vet:reject:${session.targetUserId}`).setLabel('Reject').setStyle(ButtonStyle.Danger),
  );
  const modChannel = modChannelId ? guild.channels.cache.get(String(modChannelId)) : null;
  if (!modChannel) {
    console.warn('[gatekeeping] no mod channel configured — recommendation was not posted anywhere');
    return;
  }
  try {
    await modChannel.send({ embeds: [embed], components: [row] });
  } catch (err) {
    console.warn('[gatekeeping] posting recommendation failed:', err.message);
  }
}

async function endInterview(session, farewell, spoke) {
  const { guild, channel } = session;
  const key = sessionKey(guild.id, channel.id);
  sessions.delete(key);
  activeGuild.delete(guild.id);

  const leave = async () => {
    if (session.voice) {
      voice.leaveRequestedGuild(guild);
      voice.rebalanceAll(guild.client).catch(() => {});
    }
    const list = queues.get(guild.id);
    const next = list?.shift();
    if (next) {
      startInterview(next.member, next.channel)
        .catch((err) => console.error('[gatekeeping] queued startInterview failed:', err.message));
    }
  };

  if (!session.voice || !spoke) {
    await leave();
    return;
  }
  const delay = Math.min(Math.max(farewell.length * MS_PER_CHAR, MIN_LEAVE_DELAY_MS), MAX_LEAVE_DELAY_MS);
  setTimeout(() => leave().catch((err) => console.error('[gatekeeping] leave failed:', err.message)), delay);
}

// -- mod approve/reject buttons ------------------------------------------------

/** Returns true if this interaction was ours to handle (customId prefix
 * matched), regardless of outcome — so index.js knows not to also treat it
 * as an unhandled interaction. */
export async function handleVettingButton(interaction) {
  if (!interaction.isButton() || !interaction.customId.startsWith('vet:')) return false;
  const [, action, userId] = interaction.customId.split(':');
  const guild = interaction.guild;

  const isMod = interaction.member?.permissions?.has(PermissionFlagsBits.ManageGuild)
    || isOwner(interaction.user.id);
  if (!isMod) {
    await interaction.reply({ content: "You don't have permission to act on this.", ephemeral: true });
    return true;
  }

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) {
    await interaction.update({
      content: `That member is no longer in the server.`,
      embeds: interaction.message.embeds, components: [],
    }).catch(() => interaction.reply({ content: 'That member is no longer in the server.', ephemeral: true }));
    return true;
  }

  if (action === 'approve') {
    const unverifiedId = db.getSetting(guild.id, 'gatekeeping_unverified_role');
    const verifiedId = db.getSetting(guild.id, 'gatekeeping_verified_role');
    if (unverifiedId) await member.roles.remove(String(unverifiedId)).catch((err) => console.warn('[gatekeeping] role remove failed:', err.message));
    if (verifiedId) await member.roles.add(String(verifiedId)).catch((err) => console.warn('[gatekeeping] role add failed:', err.message));
    await logAction(guild, 'vetting_approve', interaction.user.id, member.user.tag, null);
    await interaction.update({ content: `✅ Approved by ${interaction.user}.`, embeds: interaction.message.embeds, components: [] });
    try {
      await member.send("you're in — welcome! glad to have you.");
    } catch { /* DMs closed, not worth failing over */ }
    return true;
  }

  if (action === 'reject') {
    await logAction(guild, 'vetting_reject', interaction.user.id, member.user.tag, null);
    await interaction.update({ content: `❌ Rejected by ${interaction.user}.`, embeds: interaction.message.embeds, components: [] });
    try {
      await member.send("hey — you weren't approved to join this time. if things change you're welcome to try again later.");
    } catch { /* DMs closed, not worth failing over */ }
    await member.kick('Vetting rejected').catch((err) => console.warn('[gatekeeping] kick failed:', err.message));
    return true;
  }

  return true;
}

/** Test seam. */
export function _resetForTests() {
  sessions.clear();
  activeGuild.clear();
  queues.clear();
}
