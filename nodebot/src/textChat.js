// Persona + AI chat, text side. Voice (voice.js) calls recordTurn/
// formatForPrompt from conversation.js the same way this does — that
// shared buffer is the actual fix for text and voice not knowing about
// each other, not anything specific to this file.
import { PermissionsBitField } from 'discord.js';
import { chat, OpenRouterError } from './openrouter.js';
import * as credits from './credits/index.js';
import * as switching from './backends/switching.js';
import { recordTurn, formatForPrompt } from './conversation.js';
import { TOOL_SCHEMAS, runTool } from './tools.js';
import { KB_TOOL_SCHEMAS, runTool as runKbTool } from './knowledge.js';
import * as agentTools from './agentTools.js';
import * as calendar from './calendar.js';
import * as mediaTools from './mediaTools.js';
import * as musicTools from './musicTools.js';
import * as voiceTools from './voiceTools.js';
import * as channelBrains from './channelBrains.js';
import * as documents from './documents.js';
import * as github from './github.js';
import * as introspect from './introspect.js';
import * as memory from './memory.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { isOwner } from './utils.js';
import * as db from './db.js';

const HISTORY_LIMIT = 40;
const MAX_TOOL_ROUNDS = 4;
const OWNER_MAX_TOOL_ROUNDS = 8;

// Self-inspection of the local checked-out tree. Read-only by construction —
// introspect.js has no write path at all.
export const REPO_TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'repo_tree',
      description: 'List the files in your own source repository, with sizes and purposes.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'repo_search',
      description: 'Regex search across your own source code. Returns file:line: matches.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regular expression to search for' },
          glob: { type: 'string', description: 'Optional path glob to narrow the search' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'repo_read',
      description: 'Read one of your own source files, optionally a line range.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Repo-relative file path' },
          start: { type: 'integer', description: 'First line (default 1)' },
          end: { type: 'integer', description: 'Last line (default end of file)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'repo_deps',
      description: 'List your own dependencies and the runtime you are actually running on.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

export function runRepoTool(name, args = {}) {
  if (name === 'repo_tree') return introspect.repoTree();
  if (name === 'repo_search') return introspect.repoSearch(String(args.pattern || ''), String(args.glob || ''));
  if (name === 'repo_read') {
    return introspect.repoRead(String(args.path || ''), args.start || 1, args.end || null);
  }
  if (name === 'repo_deps') return introspect.repoDeps();
  return `unknown repo tool: ${name}`;
}

/**
 * Which model answers this turn.
 *
 * A turn carrying an image can be routed to its own model, because plenty of
 * cheap conversational models can't read one at all — and the reply for that
 * turn comes from whichever model is picked here, not just the description of
 * the picture. An unset pin, or a blank one saved from the dashboard, leaves
 * every turn on ai_model, so this is inert until somebody opts in.
 */
export function modelForTurn(guildId, hasImages) {
  const vision = db.getSetting(guildId, 'media_vision_model');
  if (hasImages && vision) return vision;
  return db.getSetting(guildId, 'ai_model');
}

function toolHandler(client, message, owner) {
  return async (name, args) => {
    if (name === 'recall_chat_log') return memory.recall(message.guild.id, args);
    if (name.startsWith('github_')) return github.runGithubTool(name, args);
    if (name.startsWith('repo_')) return runRepoTool(name, args);
    if (name.startsWith('kb_')) return runKbTool(message.guild.id, name, args);
    // Open to everyone: calendar.execute re-checks the owner-only bits
    // (pinging others/@everyone, another channel, editing someone else's).
    if (calendar.isCalendarTool(name)) return calendar.execute(message, name, args, owner);
    // Open to everyone: pulling the bot in/out of voice is low-stakes and the
    // point is that it shouldn't need an admin.
    if (voiceTools.isVoiceTool(name)) return voiceTools.execute(client, message, name, args);
    if (owner && name in agentTools.TOOLS) return agentTools.execute(client, message, name, args);
    // Not gated on owner: a guild can open generation up to everyone, and
    // mediaTools.execute re-checks that itself rather than trusting us.
    if (name in mediaTools.TOOLS) return mediaTools.execute(client, message, name, args);
    // Same shape: execute re-checks the admin/owner gate on music itself.
    if (name in musicTools.TOOLS) return musicTools.execute(client, message, name, args);
    // Same shape: execute re-checks the owner gate on index/delete itself.
    if (channelBrains.isChannelBrainsTool(name)) return channelBrains.execute(name, args, owner);
    return runTool(name, args);
  };
}

export async function handleMessage(client, message) {
  if (message.author.bot || !message.guild) return;
  const guildId = message.guild.id;
  if (!db.getSetting(guildId, 'ai_enabled')) return;

  const owner = isOwner(message.author.id);
  const channelName = message.channel.name || 'unknown';
  const content = message.content.replace(`<@${client.user.id}>`, '').trim();

  // An always-on channel is one the dashboard listed under ai_channels: in
  // there he answers everything, no @mention needed.
  const alwaysOn = (db.getSetting(guildId, 'ai_channels') || [])
    .map(String).includes(String(message.channel.id));
  const realMention = message.mentions.has(client.user.id);
  const mentioned = realMention || alwaysOn;
  // Lazy import: companion/session.js pulls in voice.js, which imports this
  // very file, so a static import here would be a load-time cycle.
  const companionSession = await import('./companion/session.js');
  if (realMention) {
    // A real @mention is a deliberate reciprocity signal for the companion
    // system — an always-on-channel message reaching the bot is not (the
    // person never chose to address it), so this is gated on realMention
    // specifically, never on `mentioned`. No-ops for every guild without
    // companion mode on.
    companionSession.recordDeliberateContact(guildId, message.author.id, 'mention');
  }
  // Companion Exclusive Mode: when on, only the primary companion user (and
  // owner/admins, so moderation still works) gets a reply at all — everyone
  // else is treated exactly like an unmentioned ambient message below.
  const bypassExclusive = owner
    || Boolean(message.member?.permissions?.has(PermissionsBitField.Flags.Administrator));
  const blockedByExclusive = mentioned
    && companionSession.blocksReply(guildId, message.author.id, { bypass: bypassExclusive });
  if (!mentioned || blockedByExclusive) {
    // Ambient: remember it happened, but don't reply. Same reasoning as
    // the Python bot — a message doesn't have to address the bot to be
    // something the bot should know about later (from voice, or from a
    // different channel).
    if (content) {
      recordTurn(guildId, { source: 'text', channel: channelName, speaker: message.author.username, text: content });
      memory.recordTurn(guildId, message.author.username, content, {
        source: 'text', userId: message.author.id, channel: channelName,
      });
    }
    return;
  }

  recordTurn(guildId, { source: 'text', channel: channelName, speaker: message.author.username, text: content || '(no text)' });
  memory.recordTurn(guildId, message.author.username, content, {
    source: 'text', userId: message.author.id, channel: channelName,
  });

  // Answering a pending "which backend should I switch to?" offer. Checked
  // before anything reaches a model, because the model is what's unavailable —
  // this whole path has to work with the backend down. A message that isn't an
  // answer falls through and is handled normally, so somebody who ignores the
  // offer and keeps talking doesn't lose their sentence to it.
  const answer = switching.resolveOffer(guildId, content);
  if (answer) {
    await message.reply({
      content: switching.applyAnswer(guildId, answer),
      allowedMentions: { repliedUser: false },
    });
    return;
  }

  await message.channel.sendTyping();
  // Attachments are read automatically — no tool call — and folded into the
  // user's message before it reaches the model, same as the Python bot.
  let attachmentContext = '';
  try {
    attachmentContext = await documents.buildAttachmentContext(message);
  } catch (err) {
    console.warn('[documents] attachment context failed:', err?.message || err);
  }
  // Images go to the model as multimodal parts rather than as text. Same
  // degrade-to-nothing handling as the attachment context above: a picture
  // that won't decode shouldn't cost you the reply.
  let imageParts = [];
  let imageNotes = [];
  try {
    const images = await documents.buildImageParts(message);
    imageParts = images.parts;
    imageNotes = images.notes;
  } catch (err) {
    console.warn('[documents] image parts failed:', err?.message || err);
  }
  // Repo links in the message are looked up automatically, same as the
  // Python bot's auto-attach — cached, so repeated mentions of one repo in a
  // conversation don't burn through the API rate limit.
  let repoContext = '';
  try {
    const refs = github.findRepoRefs(content).slice(0, 2);
    const lookups = await Promise.all(refs.map(([o, n]) => github.githubRepo(`${o}/${n}`)));
    repoContext = lookups.join('\n\n');
  } catch (err) {
    console.warn('[github] repo auto-attach failed:', err?.message || err);
  }
  const transcript = formatForPrompt(guildId, HISTORY_LIMIT);
  // The speaker's own profile card comes first, then guild-wide durable and
  // working memory — so who you're talking to isn't buried in the dump.
  const memoryBlock = memory.getContext(guildId, message.author.id);
  // Whether this speaker may generate images/video — the prompt has to know
  // so he doesn't offer a picture he isn't allowed to draw.
  const canGenerate = await mediaTools.allowed(message);
  // Music is gated separately and more narrowly (admin/server owner/bot
  // owner only, never open to 'everyone') — see musicTools.allowed.
  const canMakeMusic = await musicTools.allowed(message);
  const systemPrompt = buildSystemPrompt({
    client, guild: message.guild, owner, memory: memoryBlock, media: canGenerate, music: canMakeMusic,
  });
  const model = modelForTurn(guildId, imageParts.length > 0);
  const baseTools = [
    ...TOOL_SCHEMAS, ...KB_TOOL_SCHEMAS, memory.RECALL_TOOL_SCHEMA,
    ...github.GITHUB_TOOL_SCHEMAS, ...REPO_TOOL_SCHEMAS,
    ...calendar.CALENDAR_TOOL_SCHEMAS,
    ...(voiceTools.enabled() ? voiceTools.TOOL_SCHEMAS : []),
  ];
  // Media schemas hang off canGenerate, not owner — generation can be opened
  // to a whole guild, so the two permissions stack independently.
  const tools = [
    ...baseTools,
    ...(owner ? agentTools.TOOL_SCHEMAS : []),
    ...(canGenerate ? mediaTools.TOOL_SCHEMAS : []),
    ...(canMakeMusic ? musicTools.TOOL_SCHEMAS : []),
    // Sidecar feature flag first: a deploy without the sidecar never offers
    // these at all. Search stays open to the guild; indexing is owner-only.
    ...(channelBrains.enabled() ? channelBrains.TOOL_SCHEMAS : []),
    ...(channelBrains.enabled() && owner ? channelBrains.OWNER_TOOL_SCHEMAS : []),
  ];
  // Notes ride along as text even when a file was skipped, so he can say
  // "that HEIC didn't come through" instead of ignoring it silently.
  const userText = `${message.author.username}: ${content || '(no text)'}`
    + (attachmentContext ? `\n\n${attachmentContext}` : '')
    + (repoContext ? `\n\n${repoContext}` : '')
    + (imageNotes.length ? `\n\n${imageNotes.join('\n')}` : '');
  try {
    const reply = await chat([
      { role: 'system', content: `${systemPrompt}\n\nRecent conversation:\n${transcript}` },
      {
        role: 'user',
        // Plain string unless there are actually images — the multimodal array
        // form is only worth the trouble when something needs to be seen.
        content: imageParts.length
          ? [{ type: 'text', text: userText }, ...imageParts]
          : userText,
      },
    ], {
      model, tools,
      toolHandler: toolHandler(client, message, owner),
      maxToolRounds: owner ? OWNER_MAX_TOOL_ROUNDS : MAX_TOOL_ROUNDS,
      guildId,
    });
    recordTurn(guildId, { source: 'text', channel: channelName, speaker: client.user.username, text: reply });
    // userId null: Max doesn't get a profile card built about himself.
    memory.recordTurn(guildId, client.user.username, reply, {
      source: 'text', userId: null, channel: channelName,
    });
    for (let i = 0; i < reply.length; i += 1990) {
      await message.reply({ content: reply.slice(i, i + 1990), allowedMentions: { repliedUser: false } });
    }
  } catch (err) {
    // Text chat is where the out-of-credits notice gets said, because it is
    // the one surface where somebody definitely just addressed the bot and is
    // waiting on an answer. Throttled to once an hour per server: a dead
    // balance must not turn every mention in a busy channel into its own
    // demand for money.
    if (err instanceof credits.InsufficientCreditsError) {
      console.warn(`[credits] out of credits for guild ${guildId}`);
      if (credits.shouldNotify(guildId)) {
        await message.reply({
          content: credits.OUT_OF_CREDITS_MESSAGE,
          allowedMentions: { repliedUser: false },
        });
      }
      return;
    }
    // A rate-limited backend is recoverable and she knows what to switch to,
    // so she says so rather than dead-ending on "AI is unavailable".
    if (err instanceof OpenRouterError && err.status === 429) {
      const options = switching.shortlist(guildId, 'chat');
      if (options.length) {
        switching.offer(guildId, 'chat', options);
        await message.reply({
          content: switching.offerText(err.model || model, options),
          allowedMentions: { repliedUser: false },
        });
        return;
      }
    }
    if (err instanceof OpenRouterError) {
      console.error('OpenRouter error:', err.message);
      await message.reply({ content: 'AI is unavailable right now.', allowedMentions: { repliedUser: false } });
      return;
    }
    throw err;
  }
}
