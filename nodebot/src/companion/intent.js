// Deterministic pick of "why reach out" — runs BEFORE an invite is sent, so
// the companion already has conversational intent the moment the user joins.
// Once chosen for a session, session.js stores it and it is never
// recomputed (see companion/session.js) — this file only ever runs at
// decision time, not mid-conversation.
import { derivedAbsence } from './state.js';

const HIGH_IMPORTANCE = 0.7;
const ABSENCE_CHECKIN = 0.5;
const CURIOSITY_FLOOR = 0.55;
const LOW_INVESTMENT = 0.15;

/**
 * @param {object} state    from state.js's load()
 * @param {object[]} threads open threads, most important first (threads.js's openThreads)
 * @param {number} [nowSec]
 * @returns {{code: string, phrase: string, threadId?: number}}
 */
export function selectIntent(state, threads = [], nowSec = Math.floor(Date.now() / 1000)) {
  const { pressures } = state;
  const topThread = threads[0];

  // A genuinely fresh relationship — no completed conversation has ever
  // happened. Checked before everything else: there can be no real threads
  // or absence yet, and this deserves an explicit "we've never actually
  // talked" framing rather than falling through to simple_check_in's
  // vaguer "still getting to know each other" (which reads as though some
  // history already exists).
  if (!state.lastInteractionAt) {
    return {
      code: 'first_contact',
      phrase: "this is the very first time you're reaching out to this person — you have never "
        + 'talked before, so do not reference any shared history. Introduce yourself honestly: '
        + "you're new to this, and you're genuinely looking to get to know people and make a real "
        + 'connection. Ask what they are looking for from you, rather than assuming.',
    };
  }

  if (topThread && topThread.importance >= HIGH_IMPORTANCE) {
    return {
      code: 'continue_thread',
      phrase: `pick back up on "${topThread.title}" if it comes up naturally, but follow the conversation if it goes elsewhere`,
      threadId: topThread.id,
    };
  }

  const absence = derivedAbsence(state, nowSec);
  if (absence >= ABSENCE_CHECKIN && pressures.concern > 0.2) {
    return {
      code: 'check_in_absence',
      phrase: "check in gently since it's been a while — don't make it a big deal",
    };
  }

  if (topThread) {
    return {
      code: 'continue_thread',
      phrase: `ask about "${topThread.title}" — it's still open`,
      threadId: topThread.id,
    };
  }

  if (pressures.curiosity >= CURIOSITY_FLOOR) {
    return {
      code: 'share_thought',
      phrase: 'share something that has been on your mind',
    };
  }

  if (pressures.investment < LOW_INVESTMENT) {
    return {
      code: 'simple_check_in',
      phrase: "keep it low-key — you're still getting to know each other",
    };
  }

  return {
    code: 'spend_time',
    phrase: 'just spend a few minutes talking, no particular agenda',
  };
}
