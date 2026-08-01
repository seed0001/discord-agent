// Structured data models for the pressure engine. Ported from
// pressure/models.py.
//
// Everything the engine knows lives in these explicit structures (persisted
// by store.js) — never in model weights or hidden LLM memory.
//
// Signal fields stay snake_case: they map 1:1 onto SQLite columns, and the
// store round-trips rows directly rather than translating names on every
// read and write.

// Terminal signal states — a signal in one of these never charges again.
export const RESOLVED_STATES = new Set([
  'spoken',          // we addressed it ourselves
  'satisfied',       // someone else solved it
  'declined',        // the user said no thanks
  'abandoned',       // goal dropped / topic left long enough
  'expired',         // max lifetime reached
  'low_confidence',  // confidence fell below the floor
  'superseded',      // replaced by a newer signal with the same key
]);

/** One weighted piece of evidence that Max might have something to say. */
export function makeSignal({
  key,
  source,
  weight = 0,          // 0..1 base importance of this source instance
  confidence = 1,      // 0..1 how sure the classifier was
  ts = 0,              // unix time the signal was observed
  topic = '',          // topic/entity association ("deploy", "tabs-vs-spaces")
  channel_id = '',
  user_id = '',        // who the signal is about/for (cooldown scoping)
  evidence = '',       // why this signal exists, for the audit trail
  decay = 'exp',       // "exp" | "linear" | "none"
  decay_rate = 1 / 600, // per-second (exp: fraction; linear: units)
  max_lifetime = 1800, // seconds until forced expiry
  state = 'active',
  resolved_reason = '',
  resolved_ts = null,
} = {}) {
  return {
    key,
    source,
    weight,
    confidence,
    ts,
    topic,
    channel_id,
    user_id,
    evidence,
    decay,
    decay_rate,
    max_lifetime,
    state,
    resolved_reason,
    resolved_ts,
  };
}

/** Current effective strength, honouring decay and expiry. */
export function strength(s, now) {
  if (s.state !== 'active') return 0;
  const age = Math.max(0, now - s.ts);
  if (age >= s.max_lifetime) return 0;
  const base = s.weight * s.confidence;
  if (s.decay === 'exp') return base * Math.exp(-s.decay_rate * age);
  if (s.decay === 'linear') return Math.max(0, base - s.decay_rate * age);
  return base;
}

/** Mutates the signal into a resolved state. No-op if already resolved. */
export function resolveSignal(s, reason, now) {
  if (s.state !== 'active') return;
  s.state = RESOLVED_STATES.has(reason) ? reason : 'satisfied';
  s.resolved_reason = reason;
  s.resolved_ts = now;
}

/** A candidate proactive contribution, evaluated by the gate. */
export function makeProposal({
  topic = '',
  bucket = '',
  contentKey = '',        // normalized identity of the point being made
  summary = '',           // what would be said (or a summary of it)
  providesNewInfo = true,
  questionCount = 0,
  relevance = 1.0,        // 0..1 from the relevance evaluator
  channelId = '',
  userId = '',
  urgent = false,         // safety/moderation may bypass interruption hold
} = {}) {
  return {
    topic, bucket, contentKey, summary, providesNewInfo,
    questionCount, relevance, channelId, userId, urgent,
  };
}

/** A proactive message that actually went out (repetition history). */
export function makeContribution({
  ts = 0, topic = '', bucket = '', content_key = '', summary = '', channel_id = '',
} = {}) {
  return { ts, topic, bucket, content_key, summary, channel_id };
}
