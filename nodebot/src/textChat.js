// Persona + AI chat, text side. Voice (voice.js) calls recordTurn/
// formatForPrompt from conversation.js the same way this does — that
// shared buffer is the actual fix for text and voice not knowing about
// each other, not anything specific to this file.
import { chat, OpenRouterError } from './openrouter.js';
import { recordTurn, formatForPrompt } from './conversation.js';
import { TOOL_SCHEMAS, runTool } from './tools.js';
import { KB_TOOL_SCHEMAS, runTool as runKbTool } from './knowledge.js';
import * as agentTools from './agentTools.js';
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

function toolHandler(client, message, owner) {
  return async (name, args) => {
    if (name === 'recall_chat_log') return memory.recall(message.guild.id, args);
    if (name.startsWith('github_')) return github.runGithubTool(name, args);
    if (name.startsWith('repo_')) return runRepoTool(name, args);
    if (name.startsWith('kb_')) return runKbTool(message.guild.id, name, args);
    if (owner && name in agentTools.TOOLS) return agentTools.execute(client, message, name, args);
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
  const mentioned = message.mentions.has(client.user.id) || alwaysOn;
  if (!mentioned) {
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

  await message.channel.sendTyping();
  // Attachments are read automatically — no tool call — and folded into the
  // user's message before it reaches the model, same as the Python bot.
  let attachmentContext = '';
  try {
    attachmentContext = await documents.buildAttachmentContext(message);
  } catch (err) {
    console.warn('[documents] attachment context failed:', err?.message || err);
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
  const systemPrompt = buildSystemPrompt({
    client, guild: message.guild, owner, memory: memoryBlock,
  });
  const model = db.getSetting(guildId, 'ai_model');
  const baseTools = [
    ...TOOL_SCHEMAS, ...KB_TOOL_SCHEMAS, memory.RECALL_TOOL_SCHEMA,
    ...github.GITHUB_TOOL_SCHEMAS, ...REPO_TOOL_SCHEMAS,
  ];
  const tools = owner ? [...baseTools, ...agentTools.TOOL_SCHEMAS] : baseTools;
  try {
    const reply = await chat([
      { role: 'system', content: `${systemPrompt}\n\nRecent conversation:\n${transcript}` },
      {
        role: 'user',
        content: `${message.author.username}: ${content || '(no text)'}`
          + (attachmentContext ? `\n\n${attachmentContext}` : '')
          + (repoContext ? `\n\n${repoContext}` : ''),
      },
    ], {
      model, tools,
      toolHandler: toolHandler(client, message, owner),
      maxToolRounds: owner ? OWNER_MAX_TOOL_ROUNDS : MAX_TOOL_ROUNDS,
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
    if (err instanceof OpenRouterError) {
      console.error('OpenRouter error:', err.message);
      await message.reply({ content: 'AI is unavailable right now.', allowedMentions: { repliedUser: false } });
      return;
    }
    throw err;
  }
}
