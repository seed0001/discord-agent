// Automatic message moderation: banned words, invite links, mention spam.
// Ported from bot/cogs/automod.py.
//
// Plus the hyperdimensional event sentinel (GUDDA_INGESTION_CHECKLIST phase 4),
// which watches message rates, mention storms and member joins for patterns
// this server does not normally produce. Both of its switches default off —
// see the note above `observeEvent`.
import { PermissionFlagsBits } from 'discord.js';
import { logAction } from './utils.js';
import * as db from './db.js';
import { DiscordSentinel } from './gudda/index.js';

const INVITE_RE = /(discord\.gg\/|discord(?:app)?\.com\/invite\/)/i;

const DEFAULT_FANOUT_THRESHOLD = 5;
const DEFAULT_FANOUT_WINDOW_SECONDS = 30;
const DEFAULT_FANOUT_DELETE_SECONDS = 3600;

// guildId:userId -> Map<targetUserId, timestamp>
const fanoutTrackers = new Map();
// guildId:userId currently mid-ban, so a burst of messages arriving while
// the ban() call is in flight can't trigger a second ban attempt.
const fanoutBanning = new Set();

/**
 * Record the distinct members one author has @mentioned and report whether
 * they just crossed the fan-out threshold. Pure state-tracking, no Discord
 * calls, so it's cheap to unit test.
 *
 * @returns {{triggered: boolean, targetCount: number}|null} null if there
 *   are no mention targets to track.
 */
export function recordMentionFanoutAndCheck(guildId, userId, targetIds, {
  threshold = DEFAULT_FANOUT_THRESHOLD,
  windowSeconds = DEFAULT_FANOUT_WINDOW_SECONDS,
} = {}, nowMs = Date.now()) {
  if (!targetIds || targetIds.length === 0) return null;

  const trackerKey = `${guildId}:${userId}`;
  const windowMs = windowSeconds * 1000;
  let targets = fanoutTrackers.get(trackerKey);
  if (!targets) targets = new Map();
  for (const [id, ts] of targets) {
    if (nowMs - ts > windowMs) targets.delete(id);
  }
  for (const id of targetIds) targets.set(id, nowMs);

  if (targets.size >= threshold) {
    fanoutTrackers.delete(trackerKey); // one trigger per burst, not one per message
    return { triggered: true, targetCount: targets.size };
  }
  fanoutTrackers.set(trackerKey, targets);
  return { triggered: false, targetCount: targets.size };
}

/**
 * Returns true if the message was actioned (banned or flagged) as mention
 * fan-out, in which case the caller should stop — nothing left to check.
 */
async function checkMentionFanout(message) {
  if (!db.getSetting(message.guild.id, 'mention_fanout_enabled')) return false;
  if (!message.mentions?.users?.size) return false;

  const targetIds = [...message.mentions.users.keys()].filter((id) => id !== message.author.id);
  if (targetIds.length === 0) return false;

  const guildId = message.guild.id;
  const threshold = Number(db.getSetting(guildId, 'mention_fanout_threshold')) || DEFAULT_FANOUT_THRESHOLD;
  const windowSeconds = Number(db.getSetting(guildId, 'mention_fanout_window_seconds')) || DEFAULT_FANOUT_WINDOW_SECONDS;

  const result = recordMentionFanoutAndCheck(guildId, message.author.id, targetIds, { threshold, windowSeconds });
  if (!result?.triggered) return false;

  try {
    await message.delete();
  } catch (err) {
    console.warn('[automod] fan-out message delete failed:', err.message);
  }

  if (!message.member) return true; // already gone — nothing left to ban

  const banKey = `${guildId}:${message.author.id}`;
  if (fanoutBanning.has(banKey)) return true;
  fanoutBanning.add(banKey);

  try {
    const reason = `Mention fan-out: pinged ${result.targetCount} distinct members within `
      + `${windowSeconds}s (going through the member list — a scrape/raid pattern)`;
    if (!message.member.bannable) {
      console.warn(`[automod] flagged ${message.author.tag} for mention fan-out but lack permission to ban them`);
      await logAction(message.guild, 'mention_fanout_flag', 'AutoMod', message.author,
        `${reason} — ban failed, insufficient permissions`);
      return true;
    }
    const deleteSeconds = Number(db.getSetting(guildId, 'mention_fanout_delete_seconds')) || DEFAULT_FANOUT_DELETE_SECONDS;
    await message.member.ban({ reason, deleteMessageSeconds: deleteSeconds });
    await logAction(message.guild, 'mention_fanout_ban', 'AutoMod', message.author, reason);
  } catch (err) {
    console.warn('[automod] fan-out ban failed:', err.message);
  } finally {
    fanoutBanning.delete(banKey);
  }
  return true;
}

// Sentinel event thresholds — when an event is worth encoding at all.
const RATE_WINDOW = 10;          // seconds of history for the rate estimate
const RATE_THRESHOLD = 0.5;      // msgs/sec above which a MESSAGE_BURST is emitted
const STORM_WINDOW = 10;         // seconds of mention history per target
const STORM_SOURCE_THRESHOLD = 3; // distinct mentioners before it is a storm
const MUTED_ROLE_NAME = 'muted';

/** Returns a violation description string, or null if the message is clean. */
export function findViolation(guild, member, content, mentionCount) {
  if (!db.getSetting(guild.id, 'automod_enabled')) return null;

  const lower = content.toLowerCase();
  const bannedWords = db.getSetting(guild.id, 'banned_words') || [];
  for (const word of bannedWords) {
    if (word && lower.includes(word.toLowerCase())) return `banned word: ${word}`;
  }

  if (db.getSetting(guild.id, 'block_invites') && INVITE_RE.test(content)) return 'invite link';

  const maxMentions = Number(db.getSetting(guild.id, 'max_mentions')) || 0;
  if (maxMentions && mentionCount > maxMentions) return `mention spam (${mentionCount} mentions)`;

  return null;
}

// -- sentinel -----------------------------------------------------------------

const sentinels = new Map();       // guildId -> DiscordSentinel
const msgTimestamps = new Map();   // channelId -> recent message times
const mentionLog = new Map();      // targetUserId -> recent [sourceId, ts]
const autoMuted = new Set();       // members already actioned this process

function sentinelFor(guildId) {
  const gid = String(guildId);
  if (!sentinels.has(gid)) sentinels.set(gid, new DiscordSentinel());
  return sentinels.get(gid);
}

function prune(list, window, now, at = (x) => x) {
  const cutoff = now - window;
  while (list.length && at(list[0]) < cutoff) list.shift();
}

/**
 * Score one event and act on the verdict.
 *
 * Two switches, deliberately separate. `sentinel_enabled` turns on observation
 * and logging; `sentinel_quarantine` lets a QUARANTINE verdict actually mute
 * someone. Watch the log on your own traffic before granting the second.
 *
 * The reason for the split: conjunctive binding makes any change to any field
 * produce a near-orthogonal vector, so an event whose `rate` merely drifted
 * from 0.50 to 0.51 scores as maximally anomalous. Measured on ordinary
 * traffic that is ~97% QUARANTINE — as a mute trigger it would clear the
 * server. Bucketing the continuous fields (rate to a coarse band, and dropping
 * per-user ids from the fingerprint) is what makes the baseline able to learn
 * a "normal" at all; until then this is a measurement tool.
 *
 * @returns {import('./gudda/sentinel.js').SentinelReport | null}
 */
async function observeEvent(guild, userId, eventType, fields) {
  if (!db.getSetting(guild.id, 'sentinel_enabled')) return null;

  const report = sentinelFor(guild.id).observe(eventType, fields);
  if (report.verdict === 'WARN' || report.verdict === 'QUARANTINE') {
    console.log(`[sentinel] ${guild.id} ${report.message}`);
  }
  if (report.verdict === 'QUARANTINE' && db.getSetting(guild.id, 'sentinel_quarantine')) {
    await quarantine(guild, userId, report);
  }
  return report;
}

async function quarantine(guild, userId, report) {
  const member = guild.members.cache.get(String(userId));
  if (!member || autoMuted.has(member.id)) return;

  const role = guild.roles.cache.find((r) => r.name === MUTED_ROLE_NAME);
  if (!role) {
    console.warn(`[sentinel] would quarantine ${member.id} but no "${MUTED_ROLE_NAME}" role exists`);
    return;
  }
  try {
    await member.roles.add(role, `automod sentinel: ${report.message}`);
  } catch (err) {
    console.warn('[sentinel] mute failed:', err.message);
    return;
  }
  autoMuted.add(member.id);
  await logAction(guild, 'sentinel', 'AutoMod (QUARANTINE)', member.user,
    `${report.verdict}: ${report.message.slice(0, 200)}`);
}

/** Feed message traffic to the sentinel: burst rate, then mention storms. */
async function observeMessage(message, now) {
  const chKey = String(message.channel.id);
  if (!msgTimestamps.has(chKey)) msgTimestamps.set(chKey, []);
  const stamps = msgTimestamps.get(chKey);
  stamps.push(now);
  prune(stamps, RATE_WINDOW, now);

  if (stamps.length >= 3) {
    const rate = stamps.length / Math.min(RATE_WINDOW, now - stamps[0] + 1);
    if (rate >= RATE_THRESHOLD) {
      await observeEvent(message.guild, message.author.id, 'MESSAGE_BURST', {
        channel_id: chKey,
        rate: rate.toFixed(2),
        window_seconds: String(RATE_WINDOW),
      });
    }
  }

  for (const target of message.mentions.users.values()) {
    const tKey = String(target.id);
    if (!mentionLog.has(tKey)) mentionLog.set(tKey, []);
    const log = mentionLog.get(tKey);
    log.push([String(message.author.id), now]);
    prune(log, STORM_WINDOW, now, (entry) => entry[1]);
    const sources = new Set(log.map(([src]) => src)).size;
    if (sources >= STORM_SOURCE_THRESHOLD) {
      await observeEvent(message.guild, message.author.id, 'MENTION_STORM', {
        target_user_id: tKey,
        mention_count: String(log.length),
        source_count: String(sources),
      });
    }
  }
}

/** Member joins are the other raid tell — called from the guildMemberAdd hook. */
export async function checkMemberJoin(member) {
  if (!member.guild || member.user?.bot) return;
  try {
    await observeEvent(member.guild, member.id, 'MEMBER_JOIN', {
      user_id: String(member.id),
      role_count: String(member.roles?.cache?.size ?? 0),
    });
  } catch (err) {
    console.warn('[sentinel] join observation failed:', err?.message || err);
  }
}

export async function checkMessage(message) {
  if (!message.guild || message.author.bot) return;
  if (message.member?.permissions.has(PermissionFlagsBits.ManageMessages)) return;

  if (await checkMentionFanout(message)) return;

  const violation = findViolation(
    message.guild, message.member, message.content, message.mentions.users.size,
  );

  if (!violation) {
    // A clean message still tells the sentinel what normal looks like. Never
    // let that path throw — moderation must not depend on the enrichment.
    try {
      await observeMessage(message, Date.now() / 1000);
    } catch (err) {
      console.warn('[sentinel] observation failed:', err?.message || err);
    }
    return;
  }

  try {
    await message.delete();
  } catch (err) {
    console.warn('[automod] delete failed:', err.message);
    return;
  }
  await logAction(message.guild, 'automod', 'AutoMod', message.author, violation);
  try {
    const warning = await message.channel.send(
      `${message.author}, your message was removed (${violation}).`,
    );
    setTimeout(() => warning.delete().catch(() => {}), 6000).unref();
  } catch (err) {
    console.warn('[automod] warning post failed:', err.message);
  }
}

/** Test seam: drop all in-process sentinel state. */
export function _resetForTests() {
  sentinels.clear();
  msgTimestamps.clear();
  mentionLog.clear();
  autoMuted.clear();
  fanoutTrackers.clear();
  fanoutBanning.clear();
}
