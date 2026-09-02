// The daily ticker: per companion-enabled guild, decide whether to reach
// out right now. All policy (cooldowns, quiet hours, daily caps, the
// reach_out_drive formula) lives here and in state.js — the LLM is never
// asked whether to initiate, only how to phrase the invite once the
// decision is already YES (see invite.js).
import * as db from '../db.js';
import { wallParts, validTimezone } from '../calendar.js';
import * as stateMod from './state.js';
import * as events from './events.js';
import * as threadsMod from './threads.js';
import { selectIntent } from './intent.js';
import * as invite from './invite.js';
import * as session from './session.js';

const TICK_EVERY_MS = 10 * 60 * 1000; // 10 minutes — frequent enough to feel organic, cheap enough to poll

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

export function inQuietHours(guildId, atSec) {
  const start = db.getSetting(guildId, 'companion_quiet_hours_start');
  const end = db.getSetting(guildId, 'companion_quiet_hours_end');
  if (!start || !end) return false;
  const tz = db.getSetting(guildId, 'calendar_timezone');
  const safe = validTimezone(tz) ? tz : 'UTC';
  const { hour, minute } = wallParts(atSec, safe);
  const mins = hour * 60 + minute;
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const startMins = sh * 60 + sm;
  const endMins = eh * 60 + em;
  if (!Number.isFinite(startMins) || !Number.isFinite(endMins) || startMins === endMins) return false;
  return startMins < endMins
    ? mins >= startMins && mins < endMins
    : mins >= startMins || mins < endMins; // window wraps past midnight
}

function fmt(x) {
  return Number(x).toFixed(2);
}

function logDecision(guildId, state, atSec, verdict, reason) {
  console.log(
    `[COMPANION] Initiative decision: ${verdict} guild=${guildId}\n`
    + `investment=${fmt(state.pressures.investment)} reciprocity=${fmt(state.pressures.reciprocity)} `
    + `absence=${fmt(stateMod.derivedAbsence(state, atSec))} concern=${fmt(state.pressures.concern)}\n`
    + `reason=${reason}`,
  );
}

function suppressReason(state, driveResult) {
  const parts = [];
  if (state.consecutiveIgnored > 0) parts.push(`${state.consecutiveIgnored} ignored invite${state.consecutiveIgnored === 1 ? '' : 's'}`);
  if (state.pressures.initiative_confidence < 0.3) parts.push('low initiative confidence');
  if (driveResult.concernEligible) parts.push('concern exception already used');
  return parts.length ? parts.join(' + ') : 'reach_out_drive below threshold';
}

/**
 * One companion-enabled guild's decision cycle. `opts.bypassCooldown` skips
 * the cooldown/daily-cap policy checks (used by the /companion test-invite
 * debug command) but never the duplicate-session guard — that one is a
 * safety property, not a policy knob.
 */
async function evaluateGuild(client, guild, opts = {}) {
  if (!db.getSetting(guild.id, 'companion_enabled')) return;
  const roomId = db.getSetting(guild.id, 'companion_room_channel_id');
  const primaryUserId = db.getSetting(guild.id, 'companion_primary_user_id');
  if (!roomId || !primaryUserId) return;
  if (!session.isIdle(guild.id)) return; // one session in flight per guild, always enforced

  const now = nowSec();
  if (!opts.bypassCooldown && inQuietHours(guild.id, now)) return;

  const state = stateMod.load(guild.id, primaryUserId, now);

  const maxSessions = Number(db.getSetting(guild.id, 'companion_max_sessions_per_day')) || 2;
  if (!opts.bypassCooldown && state.sessionsToday >= maxSessions) return;

  const baseCooldown = Number(db.getSetting(guild.id, 'companion_min_cooldown_hours')) || 4;
  const effCooldown = stateMod.effectiveCooldownHours(state, baseCooldown);
  if (!opts.bypassCooldown && state.lastInviteAt && (now - state.lastInviteAt) / 3600 < effCooldown) return;

  const driveResult = stateMod.computeReachOutDrive(state, now);
  if (!opts.bypassCooldown && driveResult.drive < stateMod.DRIVE.INITIATE_THRESHOLD) {
    logDecision(guild.id, state, now, 'NO', suppressReason(state, driveResult));
    return;
  }

  const openThreads = threadsMod.openThreads(guild.id, primaryUserId);
  const intent = selectIntent(state, openThreads, now);
  logDecision(guild.id, state, now, 'YES', `${intent.code}${driveResult.isConcernCheckin ? ' + concern_checkin' : ''}`);

  const member = await guild.members.fetch(primaryUserId).catch(() => null);
  const roomChannel = guild.channels.cache.get(roomId);
  if (!member || !roomChannel) {
    console.warn(`[COMPANION] cannot invite guild=${guild.id} — member or room not found`);
    return;
  }

  const pattern = events.summarizePattern(guild.id, primaryUserId);
  const packet = stateMod.buildContextPacket(state, { pattern, threads: openThreads, intentPhrase: intent.phrase });

  const result = await invite.send(client, guild, member, packet.text);
  if (!result.ok) return; // dm_delivery_failed already recorded by invite.js — nothing else changes

  events.record(guild.id, primaryUserId, 'voice_invite_sent', {
    intent: intent.code, concernCheckin: driveResult.isConcernCheckin,
  });
  const updated = {
    ...state,
    invitesToday: state.invitesToday + 1,
    lastInviteAt: now,
    lastInviteWasConcernCheckin: driveResult.isConcernCheckin,
  };
  stateMod.save(guild.id, primaryUserId, updated, now);

  await session.beginWaiting(guild, member, {
    intent, spoken: result.spoken, isConcernCheckin: driveResult.isConcernCheckin, roomChannel,
  });
}

async function tick(client) {
  for (const guild of client.guilds.cache.values()) {
    // eslint-disable-next-line no-await-in-loop
    await evaluateGuild(client, guild).catch((err) => console.error(`[COMPANION] tick failed for guild ${guild.id}:`, err.message));
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

/** Force one decision cycle right now for one guild, bypassing cooldown/
 *  quiet-hours/daily-cap — the /companion test-invite debug command. */
export async function forceEvaluate(client, guild) {
  await evaluateGuild(client, guild, { bypassCooldown: true });
}
