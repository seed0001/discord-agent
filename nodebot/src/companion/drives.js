// Her own internal-life pressure engine — a separate axis from state.js's
// relationship pressures. state.js is about the relationship TO the primary
// user (investment, trust, concern...); this is about her own energy and
// mood, independent of whether anyone is even around. One row per guild —
// there is one of her, not one per relationship.
//
// Pure pressure-driven: NO wall-clock time enters anywhere in this file.
// Four buckets (energy, restlessness, boredom, socialPull), each decaying
// toward a target exponentially — same tick()-from-updatedAt math state.js
// already uses for its own pressures — except the rate/target for each
// bucket depends on her CURRENT PHASE rather than being one fixed table.
// Phase transitions happen purely because a bucket crossed its own
// threshold (nextPhase, below); nothing here ever asks what time it is.
import * as db from '../db.js';

export function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

export const PHASES = ['sleep', 'work', 'relax', 'social'];

const INITIAL_DRIVES = {
  energy: 0.8,
  restlessness: 0.3,
  boredom: 0.3,
  socialPull: 0.3,
};

// Per-phase, per-bucket { rate (1/hour), target }. Same exponential
// decay-toward-target shape as state.js's DECAY table — just switched by
// which phase she's currently in, instead of one fixed table for everyone.
const PHASE_DYNAMICS = {
  sleep: {
    energy: { rate: 0.15, target: 1.0 }, // ~6-7h to fully recover
    restlessness: { rate: 0.05, target: 0.3 },
    boredom: { rate: 0.05, target: 0.3 },
    socialPull: { rate: 0.05, target: 0.3 },
  },
  work: {
    energy: { rate: 0.08, target: 0.0 }, // ~12h of work fully drains her
    restlessness: { rate: 0.15, target: 0.0 }, // satisfied by working
    boredom: { rate: 0.06, target: 1.0 }, // builds slowly
    socialPull: { rate: 0.05, target: 1.0 }, // isolated, misses company
  },
  relax: {
    energy: { rate: 0.05, target: 0.0 }, // drains slower than work
    restlessness: { rate: 0.06, target: 1.0 }, // idle too long, gets antsy
    boredom: { rate: 0.15, target: 0.0 }, // satisfied by downtime
    socialPull: { rate: 0.05, target: 1.0 }, // still isolated
  },
  social: {
    energy: { rate: 0.06, target: 0.0 },
    restlessness: { rate: 0.02, target: 0.3 }, // roughly paused
    boredom: { rate: 0.02, target: 0.3 }, // roughly paused
    socialPull: { rate: 0.10, target: 0.1 }, // showing up itself helps
  },
};

// Thresholds — tunable constants, not settings, same "not exposed in v1"
// precedent as state.js's own DRIVE object.
export const THRESHOLDS = {
  ENERGY_SLEEP_FLOOR: 0.15, // crossing down while awake -> forced sleep
  ENERGY_WAKE_CEILING: 0.85, // crossing up while asleep -> wake
  DRIVE_INTERRUPT: 0.75, // restlessness/boredom/socialPull -> switch phase
  SOCIAL_SATISFIED_FLOOR: 0.3, // socialPull below this in `social` -> leave
};

function defaultDrives(nowSec) {
  return {
    ...INITIAL_DRIVES, phase: 'work', phaseStartedAt: nowSec, updatedAt: nowSec,
  };
}

/** Roll drives forward from updatedAt to nowSec using the CURRENT phase's
 *  dynamics for the whole gap. A phase change mid-gap is resolved by
 *  nextPhase() afterward, on this same read — the same "at most one tick of
 *  lag" tradeoff state.js's own tick() already accepts. */
export function tick(stored, nowSec = nowSeconds()) {
  const baseline = stored.updatedAt ?? nowSec;
  const dtHours = Math.max(0, (nowSec - baseline) / 3600);
  if (dtHours <= 0) return { ...stored };
  const dyn = PHASE_DYNAMICS[stored.phase] || PHASE_DYNAMICS.work;
  const next = { ...stored };
  for (const key of ['energy', 'restlessness', 'boredom', 'socialPull']) {
    const { rate, target } = dyn[key];
    next[key] = clamp01(target + (stored[key] - target) * Math.exp(-rate * dtHours));
  }
  return next;
}

/** Given already-ticked drives, decide which phase she should be in right
 *  now. Checked in priority order — only one rule fires per call:
 *   1. Energy hitting its floor is a survival need and overrides everything.
 *   2. Asleep + energy recovered -> wake into whichever drive is highest.
 *   3. Awake: socialPull is checked before restlessness/boredom — wanting
 *      company outranks generic productivity/leisure for a companion.
 *   4. In `social` with nothing happening and socialPull has faded (satisfied,
 *      or gave up waiting) -> drop into whichever of restlessness/boredom is
 *      more pressing. */
export function nextPhase(drives) {
  const {
    phase, energy, restlessness, boredom, socialPull,
  } = drives;
  const t = THRESHOLDS;

  if (phase !== 'sleep' && energy <= t.ENERGY_SLEEP_FLOOR) return 'sleep';

  if (phase === 'sleep') {
    if (energy < t.ENERGY_WAKE_CEILING) return 'sleep';
    const candidates = { work: restlessness, relax: boredom, social: socialPull };
    return Object.entries(candidates).sort((a, b) => b[1] - a[1])[0][0];
  }

  if (phase !== 'social' && socialPull >= t.DRIVE_INTERRUPT) return 'social';
  if (phase === 'work' && boredom >= t.DRIVE_INTERRUPT) return 'relax';
  if (phase === 'relax' && restlessness >= t.DRIVE_INTERRUPT) return 'work';
  if (phase === 'social' && socialPull <= t.SOCIAL_SATISFIED_FLOOR) {
    return restlessness >= boredom ? 'work' : 'relax';
  }

  return phase;
}

/**
 * Load, tick forward, and evaluate a transition — the one function everyone
 * else should call. Does NOT persist on its own (same convention as
 * state.js's load()): callers save explicitly once they've acted on the
 * result. `phaseChanged`/`previousPhase` let a caller (companion/cycle.js)
 * detect an actual transition without separately re-reading the old row.
 */
export function load(guildId, nowSec = nowSeconds()) {
  const stored = db.getCompanionDrives(guildId) || defaultDrives(nowSec);
  const ticked = tick(stored, nowSec);
  const phase = nextPhase(ticked);
  const phaseChanged = phase !== ticked.phase;
  return {
    ...ticked,
    phase,
    phaseStartedAt: phaseChanged ? nowSec : ticked.phaseStartedAt,
    updatedAt: nowSec,
    phaseChanged,
    previousPhase: ticked.phase,
  };
}

export function save(guildId, drives) {
  db.saveCompanionDrives(guildId, drives);
}

/** Debug/setup helper (see /companion cycle force): snap straight to a
 *  phase for testing, without waiting on a real threshold crossing. Resets
 *  the other three drives to safe mid-range values so the forced phase
 *  actually holds instead of immediately re-transitioning on the next tick. */
export function forcePhase(guildId, phase, nowSec = nowSeconds()) {
  if (!PHASES.includes(phase)) throw new Error(`unknown phase: ${phase}`);
  const drives = {
    energy: phase === 'sleep' ? 0.1 : 0.6,
    restlessness: 0.4,
    boredom: 0.4,
    socialPull: 0.4,
    phase,
    phaseStartedAt: nowSec,
    updatedAt: nowSec,
  };
  save(guildId, drives);
  return drives;
}
