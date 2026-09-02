// Thin, well-named wrapper over db.js's companion_events table. Kept
// separate from state.js so the pressure math file stays about numbers, not
// persistence plumbing.
//
// Event type vocabulary (from the spec): voice_invite_sent,
// voice_invite_accepted, voice_invite_ignored, dm_delivery_failed,
// user_joined_companion_room, user_initiated_contact,
// companion_initiated_contact, conversation_completed, conversation_duration,
// unresolved_topic_created, unresolved_topic_resolved,
// autonomous_project_started, autonomous_project_completed,
// autonomous_project_shared, positive_interaction, conflict_or_pushback,
// long_absence. Always structured + a small `data` object — never raw
// conversation text.
import * as db from '../db.js';

export function record(guildId, userId, type, data = null) {
  return db.addCompanionEvent(guildId, userId, type, data);
}

/** Most recent first. */
export function recent(guildId, userId, limit = 50) {
  return db.listCompanionEvents(guildId, userId, { limit });
}

/**
 * One templated line for the context packet's PATTERN field, derived from
 * recent invite outcomes — never free text, never the raw event log.
 */
export function summarizePattern(guildId, userId) {
  const events = recent(guildId, userId, 30);
  const outcomes = events.filter((e) => e.type === 'voice_invite_accepted' || e.type === 'voice_invite_ignored');
  if (!outcomes.length) return null;

  const accepted = outcomes.filter((e) => e.type === 'voice_invite_accepted').length;
  const ratio = accepted / outcomes.length;
  const style = ratio >= 0.7
    ? 'normally responds quickly'
    : ratio >= 0.4
      ? 'responds sometimes'
      : 'often misses invitations';

  // outcomes is already most-recent-first (recent() orders DESC), so a
  // leading run of 'voice_invite_ignored' is the current ignore streak.
  let streak = 0;
  for (const e of outcomes) {
    if (e.type === 'voice_invite_ignored') streak += 1;
    else break;
  }
  const streakPart = streak >= 2 ? `; missed last ${streak} invitations` : '';
  return `${style}${streakPart}`;
}
