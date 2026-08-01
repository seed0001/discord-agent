// Event & raid anomaly sentinel — the Node port of sentinel_bridge.py.
//
// Server events (joins, message bursts, mention storms, channel hops) are
// encoded as MAP hypervectors and compared against an adaptive baseline of
// what this server normally looks like. The baseline decays exponentially, so
// "normal" tracks the server as it changes rather than being fixed at startup:
//
//     baseline ← α·baseline + (1−α)·event        α = 0.98
//
// An event that scores far from the baseline is, by construction, something
// this server does not usually do. That is the whole idea: no rule has to
// describe a raid in advance.
//
// The thresholds are deliberately generous. Anything under 0.15 is normal,
// 0.15–0.35 is logged and nothing more, and only past 0.35 does automod act.

import { HDVector } from './hd.js';

export const DEFAULT_DIM = 10000;
export const ALPHA = 0.98;
export const ANOMALY_WARN = 0.15;
export const ANOMALY_QUARANTINE = 0.35;

/** Field names each event type carries. Unknown fields are ignored. */
export const EVENT_FIELDS = {
  MEMBER_JOIN: ['user_id', 'role_count'],
  MEMBER_LEAVE: ['user_id', 'presence_seconds'],
  MESSAGE_BURST: ['channel_id', 'rate', 'window_seconds'],
  MENTION_STORM: ['target_user_id', 'mention_count', 'source_count'],
  CHANNEL_HOP: ['user_id', 'from_channel', 'to_channel', 'interval_seconds'],
};

const ALL_ROLES = [...new Set([...Object.values(EVENT_FIELDS).flat(), 'event_type'])].sort();

/**
 * Encodes a Discord event as a conjunction of role-filler pairs:
 *
 *   event = role(user_id)⊗filler("42") ⊗ role(event_type)⊗filler("MEMBER_JOIN")
 */
export class DiscordEventEncoder {
  constructor(dim = DEFAULT_DIM) {
    this.dim = dim;
    this.roleVecs = new Map(
      ALL_ROLES.map((name) => [name, HDVector.fromKey(`role:${name}`, dim)]),
    );
  }

  /**
   * @returns {{conj: HDVector, disj: HDVector, bound: Map<string, HDVector>}}
   *   `conj` is the event fingerprint used for anomaly scoring. `disj` and the
   *   per-attribute vectors exist so a future diagnostic can ask which field
   *   drove a score, and are not used in the decision itself.
   */
  encode(eventType, fields = {}) {
    const all = { ...fields, event_type: eventType };
    const bound = new Map();
    for (const [name, value] of Object.entries(all)) {
      const role = this.roleVecs.get(name);
      if (!role) continue; // unknown field for this event type — ignored
      bound.set(name, role.bind(HDVector.fromKey(`filler:${String(value)}`, this.dim)));
    }

    if (!bound.size) {
      return { conj: HDVector.zeros(this.dim), disj: HDVector.zeros(this.dim), bound };
    }

    const vecs = [...bound.values()];
    let conj = vecs[0];
    let disj = vecs[0];
    for (let i = 1; i < vecs.length; i += 1) {
      conj = conj.bind(vecs[i]);
      disj = disj.bundle(vecs[i]);
    }
    return { conj, disj, bound };
  }
}

/** @typedef {{eventType: string, similarity: number, anomalyScore: number,
 *             verdict: 'INIT'|'ALLOW'|'WARN'|'QUARANTINE', message: string}} SentinelReport */

export class DiscordSentinel {
  constructor({
    dim = DEFAULT_DIM,
    alpha = ALPHA,
    warnThreshold = ANOMALY_WARN,
    quarantineThreshold = ANOMALY_QUARANTINE,
  } = {}) {
    this.dim = dim;
    this.alpha = alpha;
    this.warnThreshold = warnThreshold;
    this.quarantineThreshold = quarantineThreshold;
    this.encoder = new DiscordEventEncoder(dim);
    this.baseline = null;
    this.initialized = false;
    this.eventCount = 0;
  }

  /**
   * Score an event and fold it into the baseline.
   * @returns {SentinelReport}
   */
  observe(eventType, fields = {}) {
    this.eventCount += 1;
    const { conj } = this.encoder.encode(eventType, fields);

    if (!this.initialized) {
      this.baseline = conj;
      this.initialized = true;
      return {
        eventType,
        similarity: 1.0,
        anomalyScore: 0.0,
        verdict: 'INIT',
        message: `Baseline seeded with first ${eventType} event.`,
      };
    }

    const similarity = conj.cosineSimilarity(this.baseline);
    const anomalyScore = Math.max(0, 1 - Math.max(-1, Math.min(1, similarity)));

    let verdict;
    let message;
    if (anomalyScore >= this.quarantineThreshold) {
      verdict = 'QUARANTINE';
      message = `Severe anomaly (${eventType}): score=${anomalyScore.toFixed(3)}, sim=${similarity.toFixed(3)}`;
    } else if (anomalyScore >= this.warnThreshold) {
      verdict = 'WARN';
      message = `Anomalous event (${eventType}): score=${anomalyScore.toFixed(3)}, sim=${similarity.toFixed(3)}`;
    } else {
      verdict = 'ALLOW';
      message = `Normal (${eventType}) — score=${anomalyScore.toFixed(3)}`;
    }

    // Adaptive baseline: S ← α·S + (1−α)·event
    const a = this.alpha;
    const oneMinus = 1 - a;
    const next = new Float64Array(this.dim);
    for (let i = 0; i < this.dim; i += 1) {
      next[i] = a * this.baseline.data[i] + oneMinus * conj.data[i];
    }
    this.baseline = new HDVector(this.dim, next);

    return { eventType, similarity, anomalyScore, verdict, message };
  }

  /** Forget the learned baseline — e.g. once a verified raid is over. */
  reset() {
    this.baseline = null;
    this.initialized = false;
    this.eventCount = 0;
  }
}
