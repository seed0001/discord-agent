// Between-conversation autonomous activity.
//
// Two independent tickers:
//   - the reflection pass (every REFLECT_TICK_EVERY_MS): reviews recent
//     conversation + memory, can research via web_search when something's
//     worth digging into, and — only when it actually lands on something —
//     writes a companion_agenda row (see agenda.js) that scheduler.js and
//     session.js draw on to back real outreach with real substance instead
//     of just relationship-pressure numbers.
//   - the deferred-category lottery (hourly, unchanged from the original v1
//     scope): coding/image/music/video selection just logs intent and
//     no-ops — deeper autonomous creation is a later pass, not this one.
import * as db from '../db.js';
import * as events from './events.js';
import * as threadsMod from './threads.js';
import * as agenda from './agenda.js';
import * as stateMod from './state.js';
import * as memory from '../memory.js';
import { buildSystemPrompt } from '../systemPrompt.js';
import { chat, OpenRouterError } from '../openrouter.js';
import { getRecentTurns, formatForPrompt } from '../conversation.js';
import * as toolsMod from '../tools.js';
import * as session from './session.js';
import { botName } from '../botName.js';

const TICK_EVERY_MS = 60 * 60 * 1000; // hourly — deferred-category lottery only
const RUN_CHANCE = 0.15; // most ticks do nothing — "not a gift vending machine"

const DEFERRED_CATEGORIES = ['coding', 'image', 'music', 'video'];

const REFLECT_TICK_EVERY_MS = 5 * 60 * 1000; // "roughly every ~5 minutes"
const REFLECT_HISTORY_TURNS = 40;
const REFLECT_MAX_TOKENS = 300;
const REFLECT_MAX_TOOL_ROUNDS = 2; // bounded — this runs unattended, on a timer

// guildId -> ms timestamp of the last completed reflection pass. In-memory
// only, same tradeoff as session.js's own sessions Map and conversation.js's
// turn buffer — this app is single-process, a reset on restart just means
// one reflection pass runs on the first idle tick, which is harmless.
const lastReflectionAt = new Map();

function enabledCategories(guildId) {
  return DEFERRED_CATEGORIES.filter((c) => db.getSetting(guildId, `companion_autonomous_${c}`));
}

async function tickGuild(client, guild) {
  if (!db.getSetting(guild.id, 'companion_enabled')) return;
  const userId = db.getSetting(guild.id, 'companion_primary_user_id');
  if (!userId) return;

  // Housekeeping — runs every hourly tick regardless of the lottery below.
  // Neither of these self-prunes on write the way memory_versions does:
  // companion_threads' own archiveStale() existed but was never called from
  // anywhere, and companion_events had no retention at all. Left unwired,
  // both just grow forever — cheap, no LLM call, so no reason to gate this
  // behind RUN_CHANCE the way the creative categories are.
  threadsMod.archiveStale(guild.id, userId);
  events.prune(guild.id, userId);

  const categories = enabledCategories(guild.id);
  if (!categories.length || Math.random() > RUN_CHANCE) {
    console.log(`[COMPANION] autonomous: nothing this round guild=${guild.id}`);
    return;
  }

  const category = categories[Math.floor(Math.random() * categories.length)];
  // coding/image/music/video: deferred, see module header — log intent, no spend.
  events.record(guild.id, userId, 'autonomous_project_started', { category, deferred: true });
  console.log(`[COMPANION] autonomous: ${category} selected but deferred (v1 does not generate yet) guild=${guild.id}`);
}

async function tick(client) {
  for (const guild of client.guilds.cache.values()) {
    // eslint-disable-next-line no-await-in-loop
    await tickGuild(client, guild).catch((err) => console.error(`[COMPANION] autonomous tick failed for guild ${guild.id}:`, err.message));
  }
}

/** Parses the reflection reply. Accepts exactly `AGENDA: <text>` (case
 *  insensitive) or `NOTHING` — anything else is treated as "nothing", the
 *  same conservative default as an unparseable/empty reply, since a
 *  malformed "something" is worse than correctly saying nothing. */
function parseReflection(text) {
  const m = /^AGENDA:\s*(.+)$/ims.exec((text || '').trim());
  return m ? m[1].trim() : null;
}

async function reflectGuild(client, guild) {
  if (!db.getSetting(guild.id, 'companion_enabled')) return;
  const userId = db.getSetting(guild.id, 'companion_primary_user_id');
  if (!userId) return;
  if (!session.isIdle(guild.id)) return; // don't think out loud mid-conversation

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return;

  // Scope to the primary user's + the bot's own turns only — conversation.js's
  // buffer is guild-wide across every channel/speaker, and this pass
  // manufactures things to proactively tell them; other members' chatter
  // must not surface as "something worth telling Travis." Both name
  // conventions the codebase uses for the bot's own turns are included
  // (textChat.js uses client.user.username, dm.js uses the configured
  // botName) since either could be sitting in the buffer.
  const speakers = [...new Set([
    member.user.username, client.user.username, botName(client, guild.id),
  ])];

  const lastAt = lastReflectionAt.get(guild.id) || 0;
  const relevantTurns = getRecentTurns(guild.id, REFLECT_HISTORY_TURNS)
    .filter((t) => speakers.includes(t.speaker));
  if (!relevantTurns.some((t) => t.ts > lastAt)) {
    console.log(`[COMPANION] reflection: nothing new since last pass guild=${guild.id}`);
    return;
  }

  const pattern = events.summarizePattern(guild.id, userId);
  const openThreads = threadsMod.openThreads(guild.id, userId);
  const state = stateMod.load(guild.id, userId);
  const packet = stateMod.buildContextPacket(state, { pattern, threads: openThreads });
  const transcript = formatForPrompt(guild.id, REFLECT_HISTORY_TURNS, { speakers });

  const researchAllowed = Boolean(db.getSetting(guild.id, 'companion_autonomous_research'));
  const name = botName(client, guild.id);
  const systemPrompt = buildSystemPrompt({
    client, guild, owner: false, memory: memory.getContext(guild.id, userId),
  }) + `\n\nThis is autonomous reflection time. You are ${name}, alone, between conversations `
    + `with ${member.user.username}. Review what's actually happened recently and what you `
    + 'remember.'
    + (researchAllowed ? ' If something genuinely deserves digging into, use web_search.' : '')
    + ' If you land on something concrete and real you want to bring up next time you talk — a '
    + 'thought, a follow-up, a finding, something unresolved — respond with exactly:\n'
    + 'AGENDA: <one or two sentences, in your own voice, the actual thing you want to say>\n'
    + "Otherwise respond with exactly: NOTHING\nDon't force it — most of the time NOTHING is the "
    + `right answer.\n\n${packet.text}`;

  const model = db.getSetting(guild.id, 'ai_model');
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: transcript || '[nothing recent to review]' },
  ];

  let reply;
  try {
    reply = await chat(messages, {
      guildId: guild.id,
      model,
      maxTokens: REFLECT_MAX_TOKENS,
      maxToolRounds: REFLECT_MAX_TOOL_ROUNDS,
      tools: researchAllowed ? toolsMod.TOOL_SCHEMAS : undefined,
      toolHandler: researchAllowed ? (toolName, args) => toolsMod.runTool(toolName, args) : undefined,
    });
  } catch (err) {
    if (err instanceof OpenRouterError) {
      console.warn(`[COMPANION] reflection failed guild=${guild.id}:`, err.message);
      return;
    }
    throw err;
  }

  lastReflectionAt.set(guild.id, Date.now());

  const note = parseReflection(reply);
  if (!note) {
    console.log(`[COMPANION] reflection: nothing to add guild=${guild.id}`);
    return;
  }
  agenda.add(guild.id, userId, { note, source: researchAllowed ? 'research' : 'reflection' });
  console.log(`[COMPANION] reflection: agenda item added guild=${guild.id}`);
}

async function reflectTick(client) {
  for (const guild of client.guilds.cache.values()) {
    // eslint-disable-next-line no-await-in-loop
    await reflectGuild(client, guild).catch((err) => console.error(`[COMPANION] reflection tick failed for guild ${guild.id}:`, err.message));
  }
}

let ticker = null;
let reflectTicker = null;

export function startTicker(client) {
  if (!ticker) {
    ticker = setInterval(() => tick(client), TICK_EVERY_MS);
    ticker.unref?.();
  }
  if (!reflectTicker) {
    reflectTicker = setInterval(() => reflectTick(client), REFLECT_TICK_EVERY_MS);
    reflectTicker.unref?.();
  }
}

export function stopTicker() {
  if (ticker) clearInterval(ticker);
  if (reflectTicker) clearInterval(reflectTicker);
  ticker = null;
  reflectTicker = null;
}
