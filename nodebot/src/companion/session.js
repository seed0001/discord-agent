// Voice session lifecycle: idle -> waiting -> conversing -> idle. One
// session per guild (one primary companion user per guild — see
// companion_primary_user_id). In-memory only, same tradeoff conversation.js
// and voice.js's own pendingWake/followUpUntil maps already make: a
// mid-session reset on restart is acceptable, this never needs to survive a
// process restart.
//
// This is the one module that touches voice.js beyond speakInVoice — see
// setCompanionContext/armFollowUp/currentFollowUpEpoch/leaveRequestedGuild
// there, plus the three hooks voice.js lazily imports THIS module for
// (handleModelEnded, handleSilenceTimeout, handleConnectionLost), which is
// how "session end" stays reachable from several independent triggers
// instead of depending on any single one of them.
import * as db from '../db.js';
import * as voice from '../voice.js';
import * as stateMod from './state.js';
import * as events from './events.js';
import * as threadsMod from './threads.js';
import * as dmChat from './dm.js';

const sessions = new Map(); // guildId -> session record (see beginWaiting)

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

export function status(guildId) {
  return sessions.get(String(guildId))?.status || 'idle';
}

export function get(guildId) {
  return sessions.get(String(guildId)) || null;
}

export function isIdle(guildId) {
  return status(guildId) === 'idle';
}

/**
 * Record a strong reciprocity signal — the primary companion user
 * deliberately engaging the companion (an @mention in text or voice, a wake
 * word directed at it, a DM). No-op for anyone else, or when this guild has
 * no companion set up. Deliberately narrow: ambient/always-on-channel
 * traffic must never call this — see the callers in textChat.js and
 * voice.js, both gated on a REAL mention, never the always-on branch.
 */
/**
 * True when Companion Exclusive Mode should suppress an ordinary AI reply
 * to this speaker — the setting is on, a primary user is actually
 * configured (an unconfigured gate blocks nobody, same "not yet meaningful"
 * convention as the scheduler's own guards), this speaker isn't them, and
 * no bypass applies. Bypass (owner/admin) is the CALLER's decision — this
 * function only knows guild settings, not Discord permissions.
 */
export function blocksReply(guildId, userId, { bypass = false } = {}) {
  if (bypass) return false;
  if (!db.getSetting(guildId, 'companion_exclusive_mode')) return false;
  const primaryUserId = db.getSetting(guildId, 'companion_primary_user_id');
  if (!primaryUserId) return false;
  return String(primaryUserId) !== String(userId);
}

export function recordDeliberateContact(guildId, userId, reason) {
  if (!db.getSetting(guildId, 'companion_enabled')) return;
  const primaryUserId = db.getSetting(guildId, 'companion_primary_user_id');
  if (!primaryUserId || String(primaryUserId) !== String(userId)) return;
  events.record(guildId, userId, 'user_initiated_contact', { reason });
  let state = stateMod.load(guildId, userId);
  state = stateMod.applyEvent(state, 'user_initiated_contact', {}, nowSec());
  stateMod.save(guildId, userId, state);
}

/**
 * Join the configured Private Companion Room and start waiting for the
 * primary user, after invite.js has already confirmed delivery. Returns
 * false (does nothing) if a session is already in flight for this guild —
 * the duplicate-session guard — or the room can't be joined.
 */
export async function beginWaiting(guild, member, {
  intent, spoken, isConcernCheckin, roomChannel,
}) {
  const key = String(guild.id);
  const existing = sessions.get(key);
  if (existing && existing.status !== 'idle') return false;

  const result = await voice.wakeGuild(guild, roomChannel);
  if (!result.joined) {
    console.log(`[COMPANION] failed to join room guild=${guild.id} reason=${result.reason || 'unknown'}`);
    return false;
  }

  const timeoutMin = Number(db.getSetting(guild.id, 'companion_wait_timeout_minutes')) || 5;
  const waitTimer = setTimeout(() => {
    handleTimeout(guild).catch((err) => console.error('[COMPANION] timeout handling failed:', err.message));
  }, timeoutMin * 60 * 1000);

  sessions.set(key, {
    status: 'waiting',
    userId: String(member.id),
    roomChannelId: roomChannel.id,
    intent,
    spoken,
    isConcernCheckin: Boolean(isConcernCheckin),
    waitTimer,
    maxDurationTimer: null,
    invitedAt: nowSec(),
    startedAt: null,
  });
  return true;
}

async function handleTimeout(guild) {
  const key = String(guild.id);
  const s = sessions.get(key);
  if (!s || s.status !== 'waiting') return;
  sessions.set(key, { status: 'idle' }); // claim immediately, before any await

  try {
    voice.leaveRequestedGuild(guild);
  } catch (err) {
    console.error('[COMPANION] leave-on-timeout failed:', err.message);
  }

  events.record(guild.id, s.userId, 'voice_invite_ignored', {
    intent: s.intent.code, concernCheckin: s.isConcernCheckin,
  });

  let state = stateMod.load(guild.id, s.userId);
  state = stateMod.applyEvent(state, 'voice_invite_ignored', {}, nowSec());
  state = {
    ...state,
    consecutiveIgnored: state.consecutiveIgnored + 1,
    lastInviteWasConcernCheckin: s.isConcernCheckin,
  };
  stateMod.save(guild.id, s.userId, state);

  console.log(`[COMPANION] invite ignored guild=${guild.id} concernCheckin=${s.isConcernCheckin}`);
}

/** The primary user joined the room while a session was waiting for them —
 *  called from handleVoiceStateUpdate below. Speaks the opening line (the
 *  same text drafted for the DM/voice-clip invitation — no second LLM
 *  call), opens a follow-up window immediately so the existing wake-word/
 *  follow-up machinery carries the rest of the conversation, and starts the
 *  hard max-duration backstop. */
async function handleUserJoined(guild, member) {
  const key = String(guild.id);
  const s = sessions.get(key);
  if (!s || s.status !== 'waiting') return;
  clearTimeout(s.waitTimer);

  events.record(guild.id, member.id, 'voice_invite_accepted', { intent: s.intent.code });
  events.record(guild.id, member.id, 'user_joined_companion_room', {});

  let state = stateMod.load(guild.id, member.id);
  state = stateMod.applyEvent(state, 'voice_invite_accepted', {}, nowSec());
  state = stateMod.applyEvent(state, 'user_joined_companion_room', {}, nowSec());
  state = { ...state, consecutiveIgnored: 0, lastInviteWasConcernCheckin: false };
  stateMod.save(guild.id, member.id, state);

  const pattern = events.summarizePattern(guild.id, member.id);
  const openThreads = threadsMod.openThreads(guild.id, member.id);
  // The session's intent is read here, never recomputed — it was fixed
  // before the invite went out (companion/intent.js) specifically so the
  // companion already knows why it reached out the moment the user joins.
  const packet = stateMod.buildContextPacket(state, {
    pattern, threads: openThreads, intentPhrase: s.intent.phrase,
  });
  voice.setCompanionContext(guild.id, packet.text);

  const channel = guild.channels.cache.get(s.roomChannelId);
  const spoke = channel ? await voice.speakInVoice(guild, s.spoken) : false;
  if (channel) await voice.armFollowUp(channel, spoke, voice.currentFollowUpEpoch(channel.id));

  const maxMin = Number(db.getSetting(guild.id, 'companion_session_max_minutes')) || 15;
  const maxDurationTimer = setTimeout(() => {
    closeSession(guild, 'max_duration').catch((err) => console.error('[COMPANION] max-duration close failed:', err.message));
  }, maxMin * 60 * 1000);

  sessions.set(key, {
    ...s, status: 'conversing', waitTimer: null, maxDurationTimer, startedAt: nowSec(),
  });
  console.log(`[COMPANION] session started guild=${guild.id} intent=${s.intent.code}`);
}

/**
 * The single place a live conversation actually ends, reachable from
 * several independent triggers (see the exported handle* functions below) —
 * the [[end_session]] sentinel is only one of them, not a dependency the
 * whole feature rests on. Idempotent: claims the session (status -> idle)
 * synchronously before any await, so two triggers firing close together
 * only run this once.
 */
async function closeSession(guild, reason) {
  const key = String(guild.id);
  const s = sessions.get(key);
  if (!s || s.status !== 'conversing') return;
  clearTimeout(s.maxDurationTimer);
  sessions.set(key, { status: 'idle' });

  voice.setCompanionContext(guild.id, null);
  try {
    voice.leaveRequestedGuild(guild);
  } catch (err) {
    console.error('[COMPANION] leave-on-close failed:', err.message);
  }

  const durationSec = Math.max(0, nowSec() - (s.startedAt || nowSec()));
  events.record(guild.id, s.userId, 'conversation_completed', { reason });
  events.record(guild.id, s.userId, 'conversation_duration', { durationSec });

  let state = stateMod.load(guild.id, s.userId);
  state = stateMod.applyEvent(state, 'conversation_completed', {}, nowSec());
  state = stateMod.applyEvent(state, 'conversation_duration', { durationSec }, nowSec());
  state = {
    ...state,
    lastInteractionAt: nowSec(),
    // The only place sessions_today increments — an invite alone never does
    // (see invitesToday), so an unanswered invite can't eat the daily
    // conversation budget.
    sessionsToday: state.sessionsToday + 1,
    consecutiveIgnored: 0,
    lastInviteWasConcernCheckin: false,
  };
  stateMod.save(guild.id, s.userId, state);

  console.log(`[COMPANION] session closed guild=${guild.id} reason=${reason} durationSec=${durationSec}`);
}

export async function handleModelEnded(guild) {
  await closeSession(guild, 'model_ended');
}

/** The follow-up window closed on its own (voice.js's natural-expiry timer)
 *  — this IS the silence-timeout trigger; session.js does not run its own
 *  timer for it. `channel` is checked against the session's room so a
 *  follow-up closing on an unrelated channel doesn't end the session. */
export async function handleSilenceTimeout(guild, channel) {
  const s = sessions.get(String(guild.id));
  if (!s || s.roomChannelId !== channel.id) return;
  await closeSession(guild, 'silence');
}

export async function handleConnectionLost(guild) {
  await closeSession(guild, 'connection_lost');
}

/**
 * Wired from index.js's VoiceStateUpdate listener. Handles both halves of
 * "detecting the user joining" — accepting a pending invite, and the
 * primary user leaving mid-conversation — plus logging (never
 * auto-starting) a spontaneous, unprompted room join as a reciprocity
 * signal when no invite is active.
 */
export function handleVoiceStateUpdate(oldState, newState) {
  const guild = newState.guild || oldState.guild;
  if (!guild) return;
  if (!db.getSetting(guild.id, 'companion_enabled')) return;
  const primaryUserId = db.getSetting(guild.id, 'companion_primary_user_id');
  const roomId = db.getSetting(guild.id, 'companion_room_channel_id');
  if (!primaryUserId || !roomId) return;
  const member = newState.member || oldState.member;
  if (!member || String(member.id) !== String(primaryUserId)) return;

  const joinedRoom = newState.channelId === roomId && oldState.channelId !== roomId;
  const leftRoom = oldState.channelId === roomId && newState.channelId !== roomId;
  if (!joinedRoom && !leftRoom) return;

  const s = sessions.get(String(guild.id));

  if (joinedRoom) {
    if (s && s.status === 'waiting') {
      handleUserJoined(guild, member).catch((err) => console.error('[COMPANION] join handling failed:', err.message));
    } else if (!s || s.status === 'idle') {
      // Spontaneous — a strong reciprocity signal (see companion/scheduler.js
      // for why this counts more than incidental presence). Logged only in
      // v1; auto-starting an ad-hoc conversation from this is a reasonable
      // future extension, not built now.
      recordDeliberateContact(guild.id, member.id, 'joined_room_unprompted');
      events.record(guild.id, member.id, 'user_joined_companion_room', {});
      let state = stateMod.load(guild.id, member.id);
      state = stateMod.applyEvent(state, 'user_joined_companion_room', {}, nowSec());
      stateMod.save(guild.id, member.id, state);
    }
  } else if (leftRoom && s && s.status === 'conversing') {
    closeSession(guild, 'user_left').catch((err) => console.error('[COMPANION] close-on-leave failed:', err.message));
  }
}

/**
 * Wired from index.js's MessageCreate listener, DM branch only. Detects the
 * primary companion user replying in DM or starting a DM conversation — a
 * strong reciprocity signal (companion/scheduler.js) — and logs it. This
 * does NOT add a general DM chat feature: the bot does not hold a text
 * conversation over DM in v1, it only notices that contact happened.
 */
export function handleDirectMessage(client, message) {
  if (message.author.bot) return;
  for (const guild of client.guilds.cache.values()) {
    recordDeliberateContact(guild.id, message.author.id, 'dm');
    if (!db.getSetting(guild.id, 'companion_enabled')) continue;
    const primaryUserId = db.getSetting(guild.id, 'companion_primary_user_id');
    if (!primaryUserId || String(primaryUserId) !== String(message.author.id)) continue;
    // A real reply — see dm.js's doc comment for why this is scoped to only
    // the primary companion user rather than "the bot does DMs now." Passed
    // the raw session record rather than the module, since dm.js
    // deliberately does not import this file back (that's the actual cycle
    // risk — this file already imports voice.js).
    dmChat.respond(client, guild, message.author, message, sessions.get(String(guild.id)))
      .catch((err) => console.error('[COMPANION] DM chat reply failed:', err.message));
  }
}

/** Test seam. */
export function _resetForTests() {
  sessions.clear();
}
