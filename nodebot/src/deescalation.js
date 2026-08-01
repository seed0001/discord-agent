// De-escalation gate: context-validated, deterministic, restart-safe.
// Ported from deescalation.py.
//
// The pressure system (or any safety signal) only NOMINATES a moment. An LLM
// assessment of the recent conversation is reduced to the structured
// Assessment below, and this module's deterministic gate decides whether Max
// opens his mouth — and never with more than the restrained ladder:
//
//     stage 0: one brief neutral check-in
//     stage 1: suggest pausing / moving a personal dispute to DMs
//     stage 2: notify moderators (no punishment — ever)
//
// Profanity, loudness, disagreement, teasing, roleplay, and passionate
// debate are explicitly NOT escalation. Serious signals are repeated
// targeted insults, credible threats, escalating personal hostility,
// sustained disruptive cross-talk, and ignored requests to stop. A server
// preference for limiting harsh language can enable gentle check-ins, but
// that track is separate from safety and can never climb the ladder.
//
// Pure logic, no I/O: callers persist ConflictState and pass timestamps, so
// behaviour is deterministic and testable.

export const MIN_STEP_S = 90.0;         // minimum seconds between ladder actions
export const HARSH_COOLDOWN_S = 900.0;  // between harsh-language check-ins
export const SETTLE_S = 300.0;          // quiet/falling this long -> conflict is over
export const CONFIRMATIONS_TO_ESCALATE = 1;

export const STAGE_IDLE = -1;
export const STAGE_CHECKED_IN = 0;
export const STAGE_SUGGESTED_PAUSE = 1;
export const STAGE_MODS_NOTIFIED = 2;

const ACTIONS = {
  [STAGE_CHECKED_IN]: 'check_in',
  [STAGE_SUGGESTED_PAUSE]: 'suggest_pause',
  [STAGE_MODS_NOTIFIED]: 'notify_mods',
};

/** Structured read of the recent conversation (LLM output, validated). */
export function makeAssessment({
  ts = 0,
  tension = 'steady',          // rising | steady | falling
  participants = 2,
  targetedInsults = 0,         // insults aimed at a person, this window
  insultRepeat = false,        // same person targeted repeatedly
  credibleThreat = false,
  stopIgnored = false,         // someone asked to stop; it continued
  crossTalk = false,           // sustained disruptive talking-over
  banter = false,              // joking / teasing / roleplay / debate vibes
  harshLanguage = false,       // profanity/harshness without targeting
  summary = '',
} = {}) {
  return {
    ts,
    tension,
    participants,
    targetedInsults,
    insultRepeat,
    credibleThreat,
    stopIgnored,
    crossTalk,
    banter,
    harshLanguage,
    summary,
  };
}

/** Reasons this assessment counts as genuinely serious (not vibes). */
export function seriousReasons(a, priorConfirmations) {
  const reasons = [];
  if (a.credibleThreat) reasons.push('credible threat');
  if (a.targetedInsults >= 2) reasons.push(`repeated targeted insults (${a.targetedInsults})`);
  if (a.insultRepeat && a.tension === 'rising') reasons.push('escalating personal hostility');
  if (a.stopIgnored) reasons.push('request to stop was ignored');
  if (a.crossTalk && priorConfirmations >= 1) reasons.push('sustained disruptive cross-talk');
  return reasons;
}

export function makeState({
  stage = STAGE_IDLE,
  openedTs = 0,
  lastActionTs = 0,
  lastSeriousTs = 0,
  confirmations = 0,
  harshStreak = 0,
  lastHarshActionTs = 0,
} = {}) {
  return { stage, openedTs, lastActionTs, lastSeriousTs, confirmations, harshStreak, lastHarshActionTs };
}

/** Restart safety: state is persisted as a plain object between processes. */
export function stateFromDict(data) {
  return makeState(data || {});
}

/**
 * The deterministic gate. Returns the action (if any), why, and the updated
 * state for the caller to persist.
 */
export function decide(state, a, harshLanguagePref = false) {
  const s = { ...state };
  const now = a.ts;
  const reasons = seriousReasons(a, s.confirmations);

  // -- settling / disengagement ---------------------------------------------
  if (!reasons.length) {
    // Any non-idle stage implies a serious moment happened; measure from it.
    const quietFor = s.stage !== STAGE_IDLE ? now - s.lastSeriousTs : 0;
    if (s.stage !== STAGE_IDLE && (a.tension === 'falling' || quietFor >= SETTLE_S)) {
      return {
        action: 'none',
        settled: true,
        state: makeState({ lastHarshActionTs: s.lastHarshActionTs }),
        reasons: ['conflict settled — disengaging and resetting the ladder'],
      };
    }
  }

  // -- banter / non-escalation ----------------------------------------------
  if (a.banter && !a.credibleThreat) {
    s.harshStreak = 0;
    return {
      action: 'none',
      settled: false,
      state: s,
      reasons: ['reads as banter/teasing/roleplay/debate — not escalation'],
    };
  }

  // -- harsh language track (server preference; never climbs the ladder) ----
  if (!reasons.length) {
    if (a.harshLanguage && harshLanguagePref && s.stage === STAGE_IDLE) {
      s.harshStreak += 1;
      const cooldownClear = s.lastHarshActionTs === 0 || now - s.lastHarshActionTs >= HARSH_COOLDOWN_S;
      if (s.harshStreak >= 2 && cooldownClear) {
        s.harshStreak = 0;
        s.lastHarshActionTs = now;
        return {
          action: 'check_in',
          settled: false,
          state: s,
          reasons: ['sustained harsh language and this server prefers it dialed '
            + 'back (preference track — cannot escalate past a check-in)'],
        };
      }
      return {
        action: 'none',
        settled: false,
        state: s,
        reasons: [`harsh language noted (${s.harshStreak}x) — below the preference threshold`],
      };
    }
    return {
      action: 'none',
      settled: false,
      state: s,
      reasons: ['no serious signals: profanity/volume/disagreement alone are not escalation'],
    };
  }

  // -- serious path ----------------------------------------------------------
  s.lastSeriousTs = now;
  s.confirmations += 1;
  if (s.stage === STAGE_IDLE) s.openedTs = now;

  if (s.stage >= STAGE_MODS_NOTIFIED) {
    return {
      action: 'none',
      settled: false,
      state: s,
      reasons: [...reasons, 'moderators already notified — humans own it from here'],
    };
  }

  // Credible threats fast-track straight to the moderators.
  const nextStage = a.credibleThreat ? STAGE_MODS_NOTIFIED : s.stage + 1;

  // A non-idle stage means an action was taken at lastActionTs (0 is a valid
  // timestamp in tests — never treat it as "no action").
  if (s.stage !== STAGE_IDLE && now - s.lastActionTs < MIN_STEP_S && !a.credibleThreat) {
    return {
      action: 'none',
      settled: false,
      state: s,
      reasons: [...reasons,
        `holding — last intervention was ${Math.round(now - s.lastActionTs)}s ago `
        + `(min ${Math.round(MIN_STEP_S)}s between steps)`],
    };
  }

  if (!a.credibleThreat && s.confirmations < s.stage + 1 + CONFIRMATIONS_TO_ESCALATE) {
    return {
      action: 'none',
      settled: false,
      state: s,
      reasons: [...reasons, 'needs another confirming read before escalating further'],
    };
  }

  s.stage = nextStage;
  s.lastActionTs = now;
  return {
    action: ACTIONS[nextStage],
    settled: false,
    state: s,
    reasons: [...reasons, `ladder step -> ${ACTIONS[nextStage]}`],
  };
}
