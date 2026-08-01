// Engine configuration: buckets, signal routing, gate, cooldowns, metabolism.
// Ported from pressure/config.py.
//
// Everything tunable lives here so behaviour is inspectable and testable.
// Weights/thresholds are starting points, not gospel.

export function makeBucketConfig({
  threshold,
  gain = 1.0,             // multiplier applied to incoming signal charge
  decayRate = 1 / 900,    // per-second exponential pressure decay
  cap = 3.0,              // hard ceiling — pressure can never grow forever
  releaseFraction = 0.85, // discharged when a contribution is made
} = {}) {
  return { threshold, gain, decayRate, cap, releaseFraction };
}

export function makeEngineConfig(overrides = {}) {
  const base = {
    // Conversational buckets.
    buckets: {
      assist: makeBucketConfig({ threshold: 1.00 }),
      correct: makeBucketConfig({ threshold: 0.90 }),
      follow_up: makeBucketConfig({ threshold: 0.80 }),
      clarify: makeBucketConfig({ threshold: 1.10 }),
      moderate: makeBucketConfig({ threshold: 0.60, decayRate: 1 / 600 }),
      social: makeBucketConfig({ threshold: 1.60, decayRate: 1 / 450 }),
    },

    // source -> [bucket, default weight]. Classifier weight overrides.
    sourceRouting: {
      direct_mention: ['assist', 1.00],
      explicit_question: ['assist', 0.90],
      unresolved_blocker: ['assist', 0.80],
      stalled_progress: ['assist', 0.50],
      high_value_suggestion: ['assist', 0.60],
      incorrect_claim: ['correct', 1.00],
      promised_followup: ['follow_up', 0.85],
      uncertainty: ['clarify', 0.60],
      safety_concern: ['moderate', 1.00],
      topic_relevance: ['social', 0.30],
    },

    // Flow graph: [src, tgt, per-second rate]. Gradient-driven, capped.
    edges: [
      ['clarify', 'assist', 0.0006], // confusion slowly becomes help drive
      ['social', 'assist', 0.0004],  // topic buzz feeds willingness to help
    ],
    maxEdgeFraction: 0.5,            // per tick, flow <= this * gradient

    // Speaking gate
    minRelevance: 0.45,
    maxQuestionsPerContribution: 2,
    contributionBudget: 2,           // max proactive messages...
    budgetWindow: 600.0,             // ...per this many seconds (per channel)

    // Cooldowns (seconds) started after a proactive contribution
    cooldownGlobal: 90.0,
    cooldownChannel: 180.0,
    cooldownUser: 300.0,
    cooldownTopic: 900.0,
    refractory: 120.0,               // same idempotency key ignored this long
    repeatContentWindow: 3600.0,     // same contentKey blocked this long

    // Active-exchange detection (don't interrupt people mid-volley)
    exchangeWindow: 25.0,
    exchangeMinMessages: 3,
    exchangeMinAuthors: 2,

    // Satisfaction / staleness
    confidenceFloor: 0.25,
    topicAbandonAfter: 600.0,        // topic unmentioned this long -> abandoned

    // Metabolism: speaking energy
    energyMax: 1.0,
    energyCost: 0.40,                // per proactive contribution
    energyRegen: 1 / 900,            // per second

    // Bounded queues
    maxActiveSignals: 200,           // weakest evicted beyond this
    maxDecisionsKept: 500,
    maxContributionsKept: 200,
  };
  return { ...base, ...overrides };
}
