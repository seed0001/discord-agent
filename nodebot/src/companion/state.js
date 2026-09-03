// The relationship pressure model for the Private Companion system.
//
// Nine buckets, each a float clamped to [0, 1]: investment, reciprocity,
// trust, familiarity, concern, frustration, curiosity,
// unfinished_thread_pressure, initiative_confidence. `absence_pressure` from
// the spec is deliberately NOT a stored bucket — it is derived at read time
// from how long it has been since the last real conversation, so there is
// only one place that fact can drift out of sync (see derivedAbsence below).
//
// Everything here is pure, deterministic code — no LLM call anywhere in this
// file. Two mechanisms move the numbers: applyEvent() (structured events,
// deltas that are FUNCTIONS of current state, not constants — see
// onInviteIgnored) and tick() (time decay, run lazily whenever state is
// loaded). scheduler.js is the only caller that turns these numbers into an
// actual "should I reach out" decision (computeReachOutDrive, below).
import { wallParts, validTimezone } from '../calendar.js';
import * as db from '../db.js';

export function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

export function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

export function lerp(a, b, t) {
  return a + (b - a) * clamp01(t);
}

export const BUCKETS = [
  'investment', 'reciprocity', 'trust', 'familiarity', 'concern',
  'frustration', 'curiosity', 'unfinished_thread_pressure', 'initiative_confidence',
];

// A brand-new relationship: some baseline willingness to reach out
// (initiative_confidence) and curiosity, everything else near zero, and
// reciprocity starts neutral rather than assuming either good or bad faith.
export const INITIAL_PRESSURES = {
  investment: 0.05,
  reciprocity: 0.5,
  trust: 0.2,
  familiarity: 0.05,
  concern: 0,
  frustration: 0,
  curiosity: 0.4,
  unfinished_thread_pressure: 0,
  initiative_confidence: 0.5,
};

// -- time decay ---------------------------------------------------------------
// Exponential decay toward a per-bucket target, rate in 1/hour. Buckets not
// listed here (investment, trust, familiarity) do not decay in v1 — they are
// accumulated traits, moved only by events, not moods that fade on their own.
const DECAY = {
  concern: { rate: 0.03, target: 0 }, // ~23h half-life — worry fades once nothing's wrong
  frustration: { rate: 0.05, target: 0 }, // forgives faster than concern
  reciprocity: { rate: 0.01, target: 0.5 }, // drifts back to neutral absent new signal
  initiative_confidence: { rate: 0.015, target: 0.55 }, // slow recovery baseline after a quiet spell
  curiosity: { rate: 0.01, target: 0 },
  unfinished_thread_pressure: { rate: 0.005, target: 0 }, // a real open thread shouldn't evaporate in days
};

/** Roll `stored.pressures` forward from `stored.updatedAt` to `nowSec`. Safe
 *  to call every time state is loaded — a zero or negative gap is a no-op. */
export function tick(stored, nowSec = nowSeconds()) {
  // Nullish, not `||` — an updatedAt of exactly 0 (unix epoch) is a
  // legitimate, if unusual, timestamp and must not be treated the same as
  // "missing" (which would silently skip decay by computing a zero gap).
  const baseline = stored.updatedAt ?? nowSec;
  const dtHours = Math.max(0, (nowSec - baseline) / 3600);
  const pressures = { ...stored.pressures };
  if (dtHours > 0) {
    for (const [bucket, { rate, target }] of Object.entries(DECAY)) {
      const v = pressures[bucket] ?? target;
      pressures[bucket] = clamp01(target + (v - target) * Math.exp(-rate * dtHours));
    }
  }
  return { ...stored, pressures };
}

/** How overdue contact feels, purely a function of elapsed time — not a
 *  stored bucket. Ramps 0 -> 1 over ABSENCE_RAMP_HOURS since the last real
 *  conversation; 0 when there has never been one yet (nothing to be absent
 *  from). */
const ABSENCE_RAMP_HOURS = 72; // 3 days to read as "fully overdue"
export function derivedAbsence(state, nowSec = nowSeconds()) {
  if (!state.lastInteractionAt) return 0;
  const hours = Math.max(0, (nowSec - state.lastInteractionAt) / 3600);
  return clamp01(hours / ABSENCE_RAMP_HOURS);
}

// -- event deltas ---------------------------------------------------------
// One small pure function per event type. Deltas are functions of CURRENT
// state, not constants, so the same event reads differently depending on
// relationship maturity (investment stands in for "how established is this").

function bump(pressures, key, delta) {
  pressures[key] = clamp01((pressures[key] ?? 0) + delta);
}

const EVENT_HANDLERS = {
  voice_invite_accepted(pressures) {
    bump(pressures, 'reciprocity', 0.15);
    bump(pressures, 'investment', 0.04);
    bump(pressures, 'trust', 0.03);
    bump(pressures, 'initiative_confidence', 0.12);
    bump(pressures, 'concern', -0.1);
  },
  // The spec's worked example: the same event reads very differently early
  // vs. late in a relationship. Two ignores at investment~0.05 mostly drain
  // initiative_confidence (reach_out_drive collapses on its own, see
  // computeReachOutDrive); the same two ignores at investment~0.8 barely
  // touch confidence but raise concern instead.
  voice_invite_ignored(pressures) {
    const maturity = pressures.investment;
    bump(pressures, 'initiative_confidence', -lerp(0.25, 0.06, maturity));
    bump(pressures, 'concern', lerp(0.02, 0.12, maturity));
    bump(pressures, 'reciprocity', -lerp(0.15, 0.05, maturity));
  },
  user_joined_companion_room(pressures) {
    bump(pressures, 'reciprocity', 0.08);
    bump(pressures, 'trust', 0.03);
  },
  user_initiated_contact(pressures) {
    bump(pressures, 'reciprocity', 0.05);
    bump(pressures, 'initiative_confidence', 0.05);
    bump(pressures, 'familiarity', 0.01);
  },
  conversation_completed(pressures) {
    bump(pressures, 'investment', 0.05);
    bump(pressures, 'familiarity', 0.04);
    bump(pressures, 'trust', 0.02);
  },
  conversation_duration(pressures, data) {
    const sec = Number(data?.durationSec) || 0;
    bump(pressures, 'familiarity', clamp01(Math.min(sec / 3600, 1)) * 0.05);
  },
  unresolved_topic_created(pressures) {
    bump(pressures, 'unfinished_thread_pressure', 0.15);
  },
  unresolved_topic_resolved(pressures) {
    bump(pressures, 'unfinished_thread_pressure', -0.15);
    bump(pressures, 'investment', 0.02);
  },
  autonomous_project_completed(pressures) {
    bump(pressures, 'curiosity', 0.05);
  },
  autonomous_project_shared(pressures) {
    bump(pressures, 'investment', 0.03);
    bump(pressures, 'trust', 0.02);
  },
  positive_interaction(pressures) {
    bump(pressures, 'trust', 0.05);
    bump(pressures, 'investment', 0.03);
    bump(pressures, 'frustration', -0.05);
  },
  conflict_or_pushback(pressures) {
    bump(pressures, 'frustration', 0.08);
    bump(pressures, 'trust', -0.03);
  },
  long_absence(pressures) {
    bump(pressures, 'concern', lerp(0.03, 0.15, pressures.investment));
  },
  // voice_invite_sent, companion_initiated_contact, dm_delivery_failed,
  // autonomous_project_started: logged for the event history / PATTERN
  // summary, but carry no direct pressure delta of their own — the delta
  // belongs to the event that records the OUTCOME (accepted/ignored/etc).
};

/** Apply one structured event to a state object, returning a new state (the
 *  input is not mutated). Unknown event types are a no-op — logged elsewhere,
 *  companion/events.js owns the full vocabulary. */
export function applyEvent(state, type, data, nowSec = nowSeconds()) {
  const pressures = { ...state.pressures };
  EVENT_HANDLERS[type]?.(pressures, data);
  return tick({ ...state, pressures }, nowSec);
}

// -- persistence ----------------------------------------------------------

function defaultState(nowSec) {
  return {
    pressures: { ...INITIAL_PRESSURES },
    lastInteractionAt: null,
    lastInviteAt: null,
    lastInviteWasConcernCheckin: false,
    consecutiveIgnored: 0,
    sessionsToday: 0,
    invitesToday: 0,
    dailyCountersDate: null,
    updatedAt: nowSec,
  };
}

function guildDateKey(guildId, nowSec) {
  const tz = db.getSetting(guildId, 'calendar_timezone');
  const safe = validTimezone(tz) ? tz : 'UTC';
  const { year, month, day } = wallParts(nowSec, safe);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Load a member's relationship state, ticking decay forward and resetting
 *  the daily invite/session counters if the guild-local date has rolled
 *  over since the last write. Never persists on its own — callers save
 *  explicitly once they've made whatever change they're making. */
export function load(guildId, userId, nowSec = nowSeconds()) {
  const stored = db.getCompanionState(guildId, userId) || defaultState(nowSec);
  let state = tick(stored, nowSec);
  const today = guildDateKey(guildId, nowSec);
  if (state.dailyCountersDate !== today) {
    state = { ...state, sessionsToday: 0, invitesToday: 0, dailyCountersDate: today };
  }
  return state;
}

export function save(guildId, userId, state, nowSec = nowSeconds()) {
  db.saveCompanionState(guildId, userId, { ...state, updatedAt: nowSec });
}

// -- context packet ---------------------------------------------------------

function fmt(x) {
  const s = clamp01(x).toFixed(2);
  return s.startsWith('0.') ? s.slice(1) : s;
}

const STANCE_RULES = [
  { key: 'trust', min: 0.7, label: 'familiar' },
  { key: 'concern', min: 0.75, label: 'noticeably worried' },
  { key: 'concern', min: 0.4, max: 0.75, label: 'slightly concerned' },
  { key: 'frustration', min: 0.5, label: 'a little frustrated' },
  { key: 'curiosity', min: 0.6, label: 'curious about something' },
];

function buildStance(pressures) {
  const labels = [];
  for (const rule of STANCE_RULES) {
    const v = pressures[rule.key];
    if (v >= rule.min && (rule.max === undefined || v < rule.max)) labels.push(rule.label);
  }
  // A behavioral caution, not just a description — this is what keeps the
  // model from turning "slightly concerned" into a guilt trip.
  if (pressures.concern >= 0.4) labels.push("don't overreact");
  return labels.join(', ');
}

/**
 * Render the compact REL/PATTERN/OPEN/STANCE/INTENT block that gets injected
 * into the system prompt. Entirely from code — the model never sees raw
 * event history or the pressure math, only this and normal conversation
 * context.
 *
 * @param {object} state         from load()
 * @param {object} opts
 * @param {string} [opts.pattern]      one line from events.js's summarizePattern
 * @param {Array}  [opts.threads]      open threads, most important first
 * @param {string} [opts.intentPhrase] the session's fixed intent phrase
 * @param {string} [opts.agendaNote]   a pending item from the autonomous
 *   reflection loop (companion/agenda.js) — something real she wants to
 *   bring up, as opposed to the abstract pressure numbers below it
 * @param {number} [opts.nowSec]
 */
export function buildContextPacket(state, {
  pattern, threads = [], intentPhrase, agendaNote, nowSec = nowSeconds(),
} = {}) {
  const { pressures } = state;
  const absence = derivedAbsence(state, nowSec);
  const rel = [
    `investment=${fmt(pressures.investment)}`,
    `reciprocity=${fmt(pressures.reciprocity)}`,
    `trust=${fmt(pressures.trust)}`,
    `concern=${fmt(pressures.concern)}`,
    `frustration=${fmt(pressures.frustration)}`,
  ].join(' ');
  const lines = [`REL: ${rel}`];
  if (pattern) lines.push(`PATTERN: ${pattern}`);
  const open = threads.slice(0, 3).map((t) => t.title).join('; ');
  if (open) lines.push(`OPEN: ${open}`);
  const stance = buildStance(pressures);
  if (stance) lines.push(`STANCE: ${stance}`);
  if (intentPhrase) lines.push(`INTENT: ${intentPhrase}`);
  if (agendaNote) lines.push(`AGENDA: ${agendaNote}`);
  return { text: lines.join('\n'), absence };
}

// -- reach_out_drive (see companion/scheduler.js for how this is used) ------
// Tunable constants, chosen conservatively. Not exposed as settings in v1.
export const DRIVE = {
  THREAD_WEIGHT: 0.6,
  MATURE_INVESTMENT: 0.55,
  ABNORMAL_ABSENCE: 0.6,
  CONCERN_FLOOR: 0.35,
  CONCERN_BONUS_SCALE: 0.9,
  RESISTANCE_PER_IGNORE: 0.12,
  RESISTANCE_CONCERN_IGNORED_SPIKE: 0.5,
  INITIATE_THRESHOLD: 0.55,
  CONCERN_IGNORED_COOLDOWN_MULT: 3, // effectiveCooldown multiplier after a concern check-in is ignored too
};

/**
 * A single competing-pressures score — never a hard veto from any one
 * bucket. Low initiative_confidence weighs against reaching out but does
 * not categorically forbid it: a mature relationship with a genuinely
 * abnormal absence and rising concern can still push this over threshold
 * once (a "concerned check-in"), even while initiative_confidence itself is
 * depressed from recent ignores.
 */
export function computeReachOutDrive(state, nowSec = nowSeconds()) {
  const { pressures } = state;
  const absence = derivedAbsence(state, nowSec);
  const concernEligible = pressures.investment > DRIVE.MATURE_INVESTMENT
    && absence > DRIVE.ABNORMAL_ABSENCE
    && pressures.concern > DRIVE.CONCERN_FLOOR;
  const concernBonus = concernEligible ? pressures.concern * DRIVE.CONCERN_BONUS_SCALE : 0;

  const concernCheckinIgnored = state.lastInviteWasConcernCheckin && state.consecutiveIgnored > 0;
  const ignoreResistance = state.consecutiveIgnored * DRIVE.RESISTANCE_PER_IGNORE
    + (concernCheckinIgnored ? DRIVE.RESISTANCE_CONCERN_IGNORED_SPIKE : 0);

  const drive = pressures.initiative_confidence
    + DRIVE.THREAD_WEIGHT * pressures.unfinished_thread_pressure
    + concernBonus
    - ignoreResistance;

  return {
    drive,
    concernBonus,
    concernEligible,
    ignoreResistance,
    isConcernCheckin: concernEligible && drive >= DRIVE.INITIATE_THRESHOLD
      && pressures.initiative_confidence < DRIVE.INITIATE_THRESHOLD,
  };
}

/** Minimum wait before the next invite attempt. Normally the flat setting;
 *  extended when the last invite was a concern check-in that got ignored,
 *  too — "resistance climbs hard and she backs off," not silence forever. */
export function effectiveCooldownHours(state, baseHours) {
  if (state.lastInviteWasConcernCheckin && state.consecutiveIgnored > 0) {
    return baseHours * (1 + DRIVE.CONCERN_IGNORED_COOLDOWN_MULT);
  }
  return baseHours;
}
