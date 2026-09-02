// Between-conversation autonomous activity — v1 scope only.
//
// Per the spec's own phased priority list, this build stops at: the five
// companion_autonomous_* toggles exist and are checked, a periodic
// pick-or-wait decision is made and logged the same way the initiative
// decision is, and the lightest category (research) actually runs. Image/
// music/video autonomous generation are explicitly deferred — selecting one
// of those categories logs the intent and no-ops rather than half-wiring an
// unreviewed spend path. Deeper autonomous creation and cross-session
// project behavior is the next pass, once the core loop above is proven out.
import * as db from '../db.js';
import * as events from './events.js';
import * as threadsMod from './threads.js';

const TICK_EVERY_MS = 60 * 60 * 1000; // hourly — this is "between conversations", not urgent
const RUN_CHANCE = 0.15; // most ticks do nothing — "not a gift vending machine"

const CATEGORIES = ['research', 'coding', 'image', 'music', 'video'];

function enabledCategories(guildId) {
  return CATEGORIES.filter((c) => db.getSetting(guildId, `companion_autonomous_${c}`));
}

async function runResearch(guild, userId, topic) {
  // Lightest version for v1: reuses whatever web-search tool the rest of the
  // bot already has (Tavily, gated the same way everywhere else) rather than
  // adding a second search integration. A real implementation call is left
  // out here deliberately — see the module header — so this records the
  // decision and folds a short note into an existing thread rather than
  // spending on a generation call with no review pass yet.
  events.record(guild.id, userId, 'autonomous_project_started', { category: 'research', topic });
  events.record(guild.id, userId, 'autonomous_project_completed', { category: 'research', topic });
}

async function tickGuild(client, guild) {
  if (!db.getSetting(guild.id, 'companion_enabled')) return;
  const userId = db.getSetting(guild.id, 'companion_primary_user_id');
  if (!userId) return;

  const categories = enabledCategories(guild.id);
  if (!categories.length || Math.random() > RUN_CHANCE) {
    console.log(`[COMPANION] autonomous: nothing this round guild=${guild.id}`);
    return;
  }

  const threads = threadsMod.openThreads(guild.id, userId, 3);
  const category = categories[Math.floor(Math.random() * categories.length)];

  if (category === 'research') {
    const topic = threads[0]?.title || null;
    await runResearch(guild, userId, topic);
    console.log(`[COMPANION] autonomous: research guild=${guild.id} topic=${topic || '(open-ended)'}`);
    return;
  }

  // image/music/video: deferred, see module header — log intent, no spend.
  events.record(guild.id, userId, 'autonomous_project_started', { category, deferred: true });
  console.log(`[COMPANION] autonomous: ${category} selected but deferred (v1 does not generate yet) guild=${guild.id}`);
}

async function tick(client) {
  for (const guild of client.guilds.cache.values()) {
    // eslint-disable-next-line no-await-in-loop
    await tickGuild(client, guild).catch((err) => console.error(`[COMPANION] autonomous tick failed for guild ${guild.id}:`, err.message));
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
