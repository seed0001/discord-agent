// The speaking gate: all conditions must pass before Max speaks unprompted.
// Ported from pressure/gate.py.
//
// Deterministic code enforces every condition. The LLM may have drafted the
// proposal and scored its relevance upstream, but nothing here trusts it to
// self-limit.

export class SpeakingGate {
  constructor(store, config, cooldowns) {
    this.store = store;
    this.config = config;
    this.cooldowns = cooldowns;
  }

  evaluate({
    proposal, now, pressures, topicPressure, exchangeActive, energy, topicState, record = true,
  }) {
    const c = this.config;
    const reasons = [];
    const bucketCfg = c.buckets[proposal.bucket];

    // 1. total relevant pressure over threshold
    if (!bucketCfg) {
      reasons.push(`unknown bucket '${proposal.bucket}'`);
    } else if (topicPressure < bucketCfg.threshold) {
      reasons.push(`pressure ${topicPressure.toFixed(2)} below threshold ${bucketCfg.threshold.toFixed(2)}`);
    }

    // 2. relevant to the current topic
    if (proposal.relevance < c.minRelevance) {
      reasons.push(`relevance ${proposal.relevance.toFixed(2)} below ${c.minRelevance}`);
    }

    // 3. new, useful information or action
    if (!proposal.providesNewInfo) reasons.push('adds no new information or action');
    if (proposal.questionCount > c.maxQuestionsPerContribution) {
      reasons.push(`${proposal.questionCount} questions exceeds max ${c.maxQuestionsPerContribution}`);
    }

    // 4. same point not already made
    for (const contrib of this.store.contributions()) {
      if (contrib.content_key === proposal.contentKey && now - contrib.ts < c.repeatContentWindow) {
        reasons.push(`same point already made at t=${Math.round(contrib.ts)}`);
        break;
      }
    }

    // 5. no active cooldowns
    const held = this.cooldowns.active(now, proposal.channelId, proposal.userId, proposal.topic);
    if (held.length) reasons.push(`cooldown active: ${held.join(', ')}`);

    // 6. target issue still live
    if (topicState !== 'active') reasons.push(`topic is ${topicState}`);

    // 7. don't interrupt an active exchange (urgent moderation excepted)
    if (exchangeActive && !proposal.urgent) reasons.push('active exchange in progress');

    // budget: proactive contributions per channel per window
    const recent = this.store.contributions().filter(
      (x) => x.channel_id === proposal.channelId && now - x.ts < c.budgetWindow,
    );
    if (recent.length >= c.contributionBudget) {
      reasons.push(`budget spent (${recent.length}/${c.contributionBudget} in window)`);
    }

    // metabolism: enough energy to speak
    if (energy < c.energyCost) {
      reasons.push(`energy ${energy.toFixed(2)} below cost ${c.energyCost}`);
    }

    const rounded = {};
    for (const [k, v] of Object.entries(pressures)) rounded[k] = Math.round(v * 1e4) / 1e4;

    const decision = {
      ts: now,
      allowed: reasons.length === 0,
      reasons: reasons.length ? reasons : ['all gate conditions passed'],
      proposalTopic: proposal.topic,
      proposalBucket: proposal.bucket,
      proposalSummary: proposal.summary.slice(0, 200),
      channelId: proposal.channelId,
      pressures: rounded,
    };
    if (record) this.store.addDecision(decision, this.config.maxDecisionsKept);
    return decision;
  }
}
