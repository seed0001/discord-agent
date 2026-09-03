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
import { chat, OpenRouterError } from '../openrouter.js';
import * as memory from '../memory.js';
import { buildSystemPrompt } from '../systemPrompt.js';
import * as stateMod from './state.js';
import * as events from './events.js';
import * as threadsMod from './threads.js';
import * as dmChat from './dm.js';

const sessions = new Map(); // guildId -> session record (see beginWaiting)

// How long to keep the room reserved (and the session "conversing") after the
// primary user leaves, before treating it as a real end — long enough to
// survive a quick reconnect/rejoin without breaking continuity, short enough
// that a genuine departure still closes out promptly.
const LEAVE_GRACE_MS = 45_000;

// A generic, in-character-neutral fallback for the rare case the opener call
// returns nothing usable — better than silently failing to speak, and must
// NOT fall back to replaying the DM's `spoken` line (that's the bug this
// exists to fix).
const FALLBACK_OPENER = "hey — glad you're here.";

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
  intent, spoken, isConcernCheckin, roomChannel, agendaNote = null,
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
    agendaNote,
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

/** One short LLM call the moment the invited user actually joins voice —
 *  replaces blindly replaying the DM's `spoken` line (which they already
 *  heard as a voice clip / read as text) with a fresh reaction anchored on
 *  the same context: open threads and whatever agenda item motivated this
 *  invite in the first place. Real conversational model, not background/
 *  utility — this is a real thing a person hears, same reasoning as
 *  invite.js's own draft call. `guild.client` avoids needing a separate
 *  client param — discord.js Guild instances carry it. */
async function draftOpener(guild, member, packetText) {
  const model = db.getSetting(guild.id, 'ai_model');
  const systemPrompt = buildSystemPrompt({
    client: guild.client, guild, owner: false, memory: memory.getContext(guild.id, member.id),
  }) + '\n\nYou already sent them a DM invitation, and the voice clip on it already said your '
    + "opening thought — they've now actually joined voice. Do NOT repeat or rephrase that "
    + "invitation. React naturally to them showing up, in the moment, continuing from what's "
    + 'actually on your mind below. One or two short sentences, natural to say out loud, no '
    + `markdown.\n\n${packetText}`;
  try {
    const reply = await chat([{ role: 'system', content: systemPrompt }], {
      guildId: guild.id, model, maxTokens: 120,
    });
    return (reply || '').trim() || FALLBACK_OPENER;
  } catch (err) {
    if (err instanceof OpenRouterError) {
      console.warn('[COMPANION] opener draft failed, using fallback:', err.message);
      return FALLBACK_OPENER;
    }
    throw err;
  }
}

/** The primary user joined the room while a session was waiting for them —
 *  called from handleVoiceStateUpdate below. Drafts and speaks a fresh
 *  opening line (see draftOpener — deliberately NOT the DM's `spoken` text,
 *  they already got that), opens a follow-up window immediately so the
 *  existing wake-word/follow-up machinery carries the rest of the
 *  conversation, and starts the hard max-duration backstop. */
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
    pattern, threads: openThreads, intentPhrase: s.intent.phrase, agendaNote: s.agendaNote,
  });
  voice.setCompanionContext(guild.id, packet.text);

  const channel = guild.channels.cache.get(s.roomChannelId);
  const opener = channel ? await draftOpener(guild, member, packet.text) : null;
  const spoke = opener ? await voice.speakInVoice(guild, opener) : false;
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
  clearTimeout(s.leaveGraceTimer);
  voice.endGraceHold(guild.id); // no-op if a leave-grace window wasn't active
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
  // A leave-grace window is already deciding whether this session ends —
  // don't let the follow-up window's own silence timer (which keeps running
  // down even while the user is physically out of the room, since no speech
  // is arriving either way) race it into closing early.
  if (s.awaitingReturn) return;
  await closeSession(guild, 'silence');
}

export async function handleConnectionLost(guild) {
  await closeSession(guild, 'connection_lost');
}

/** The leave-grace window (see handleVoiceStateUpdate's leave branch) ran out
 *  with no rejoin — actually end the conversation now. `epoch` guards against
 *  a stale timer from an earlier leave/rejoin cycle closing a session that
 *  has already moved on (belt-and-suspenders alongside the clearTimeout on
 *  rejoin, mirroring voice.js's own followUpEpoch pattern). */
async function handleGraceExpired(guild, epoch) {
  const s = sessions.get(String(guild.id));
  if (!s || s.status !== 'conversing' || !s.awaitingReturn || s.leaveEpoch !== epoch) return;
  voice.endGraceHold(guild.id);
  await closeSession(guild, 'user_left');
}

/**
 * Wired from index.js's VoiceStateUpdate listener. Handles both halves of
 * "detecting the user joining" — accepting a pending invite, and the
 * primary user leaving mid-conversation — plus logging (never
 * auto-starting) a spontaneous, unprompted room join as a reciprocity
 * signal when no invite is active.
 *
 * A leave mid-conversation does not end the session immediately: it opens a
 * LEAVE_GRACE_MS window (voice.beginGraceHold suppresses voice.js's own
 * empty-channel teardown for it — see voice.js's rebalance) so a quick
 * disconnect/rejoin resumes in place instead of restarting. index.js
 * registers this listener BEFORE voice.js's own for exactly this reason:
 * beginGraceHold must run before rebalance gets a chance to tear the
 * connection down on the same event.
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

  const key = String(guild.id);
  const s = sessions.get(key);

  if (joinedRoom) {
    if (s && s.status === 'waiting') {
      handleUserJoined(guild, member).catch((err) => console.error('[COMPANION] join handling failed:', err.message));
    } else if (s && s.status === 'conversing' && s.awaitingReturn) {
      // Rejoined within the grace window — resume in place, no re-invite,
      // no forced new line (that would just recreate the duplicate-message
      // problem). The existing wake-word/follow-up flow picks back up
      // naturally once they speak.
      clearTimeout(s.leaveGraceTimer);
      voice.endGraceHold(guild.id);
      sessions.set(key, {
        ...s, awaitingReturn: false, leaveGraceTimer: null,
      });
      console.log(`[COMPANION] rejoined within grace window guild=${guild.id}`);
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
  } else if (leftRoom && s && s.status === 'conversing' && !s.awaitingReturn) {
    // Synchronous, deliberately not deferred into an async function — must
    // run before control returns to EventEmitter.emit so voice.js's
    // rebalance (the next listener for this same event) sees the hold.
    voice.beginGraceHold(guild.id);
    const epoch = (s.leaveEpoch || 0) + 1;
    const leaveGraceTimer = setTimeout(() => {
      handleGraceExpired(guild, epoch).catch((err) => console.error('[COMPANION] grace-expiry close failed:', err.message));
    }, LEAVE_GRACE_MS);
    sessions.set(key, {
      ...s, awaitingReturn: true, leaveEpoch: epoch, leaveGraceTimer,
    });
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
