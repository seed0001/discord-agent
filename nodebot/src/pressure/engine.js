// The pressure engine: decides whether Max has earned the right to speak
// without being addressed. Ported from pressure/engine.py.
//
// Deterministic core — no wall clock (callers pass `now`), no network, no
// LLM. The LLM's only roles are upstream: classify messages into Signals and
// draft Proposals with a relevance score. Everything that limits behaviour
// (thresholds, cooldowns, budgets, repetition, discharge) is enforced here.
//
// Lifecycle per host loop:
//     engine.observeMessage(...)   // every message (incl. Max's own)
//     engine.ingest(signal)        // classifier output
//     engine.tick(now)             // charge decay, flow, expiry, satisfaction
//     const decision = engine.evaluate(proposal, now)
//     if (decision.allowed) { ...send... ; engine.recordSpoken(proposal, now) }
//
// The Python version took a threading lock around each public method. Node
// runs this on a single event loop and every method here is synchronous, so
// there is no interleaving point to guard.
import { makeEngineConfig } from './config.js';
import { CooldownManager } from './cooldowns.js';
import { SpeakingGate } from './gate.js';
import { makeContribution, resolveSignal, strength } from './models.js';
import { SqliteStore } from './store.js';

export class PressureEngine {
  constructor(store = null, config = null) {
    this.store = store || new SqliteStore(':memory:');
    this.config = config || makeEngineConfig();
    this.cooldowns = new CooldownManager(this.store, this.config);
    this.gate = new SpeakingGate(this.store, this.config, this.cooldowns);

    const pressures = this.store.getPressures();
    for (const name of Object.keys(this.config.buckets)) {
      if (!(name in pressures)) pressures[name] = 0;
    }
    this.store.setPressures(pressures);
    if (this.store.kvGet('energy') === null) this.store.kvSet('energy', this.config.energyMax);
    if (this.store.kvGet('last_tick') === null) this.store.kvSet('last_tick', null);
  }

  // -- observation ------------------------------------------------------------

  /** Track message flow for exchange detection, topic recency, and the
   * self-trigger guard. Max's own messages never generate pressure. */
  observeMessage(now, channelId, authorId, isSelf, topic = '') {
    if (!isSelf) {
      let times = this.store.kvGet(`msg_times:${channelId}`, []);
      times = times.filter((t) => now - t[0] < this.config.exchangeWindow * 2);
      times.push([now, authorId]);
      this.store.kvSet(`msg_times:${channelId}`, times.slice(-30));
    }
    if (topic) {
      this.store.kvSet(`topic_seen:${topic}`, now);
      this.store.kvSet('current_topic', topic);
    }
  }

  exchangeActive(now, channelId) {
    const c = this.config;
    const times = this.store.kvGet(`msg_times:${channelId}`, []);
    const recent = times.filter((t) => now - t[0] < c.exchangeWindow);
    const authors = new Set(recent.map((t) => t[1]));
    return recent.length >= c.exchangeMinMessages && authors.size >= c.exchangeMinAuthors;
  }

  // -- signal collection ------------------------------------------------------

  /** Add a signal. Returns false if dropped (idempotent replay, refractory
   * period, unknown source, or below the confidence floor). */
  ingest(signal, now = null) {
    const at = now === null ? signal.ts : now;
    if (!(signal.source in this.config.sourceRouting)) return false;
    if (signal.confidence < this.config.confidenceFloor) return false;

    const existing = this.store.getSignal(signal.key);
    if (existing) {
      if (existing.state === 'active') return false; // same key never charges twice
      // A resolved signal's key stays quiet during the refractory period.
      if (existing.resolved_ts !== null && at - existing.resolved_ts < this.config.refractory) {
        return false;
      }
      resolveSignal(existing, 'superseded', at);
      this.store.upsertSignal(existing);
      signal.key = `${signal.key}#r${Math.floor(at)}`;
    }

    const [bucketName, defaultWeight] = this.config.sourceRouting[signal.source];
    if (signal.weight <= 0) signal.weight = defaultWeight;

    // Bounded queue: evict the weakest active signal when full.
    const active = this.store.signals('active');
    if (active.length >= this.config.maxActiveSignals) {
      const weakest = active.reduce((a, b) => (strength(a, at) <= strength(b, at) ? a : b));
      resolveSignal(weakest, 'expired', at);
      this.store.upsertSignal(weakest);
    }

    this.store.upsertSignal(signal);

    // Charge the bucket (capped — pressure can never grow forever).
    const cfg = this.config.buckets[bucketName];
    const pressures = this.store.getPressures();
    const charge = cfg.gain * signal.weight * signal.confidence;
    pressures[bucketName] = Math.min(cfg.cap, pressures[bucketName] + charge);
    this.store.setPressures(pressures);
    this.store.kvSet(`topic_seen:${signal.topic}`, at);
    return true;
  }

  // -- metabolism / decay / flow (the tick) -----------------------------------

  tick(now) {
    const last = this.store.kvGet('last_tick');
    this.store.kvSet('last_tick', now);
    const dt = last !== null ? Math.max(0, now - last) : 0;
    if (dt === 0) {
      this.expireSignals(now);
      return;
    }

    const pressures = this.store.getPressures();

    // decay
    for (const [name, cfg] of Object.entries(this.config.buckets)) {
      pressures[name] *= Math.exp(-cfg.decayRate * dt);
    }

    // flow along edges (gradient-driven, capped)
    for (const [src, tgt, rate] of this.config.edges) {
      const gradient = pressures[src] - pressures[tgt];
      if (gradient <= 0) continue;
      const flow = Math.min(gradient * rate * dt, gradient * this.config.maxEdgeFraction);
      pressures[src] -= flow;
      pressures[tgt] = Math.min(this.config.buckets[tgt].cap, pressures[tgt] + flow);
    }

    const rounded = {};
    for (const [k, v] of Object.entries(pressures)) rounded[k] = Math.round(v * 1e6) / 1e6;
    this.store.setPressures(rounded);

    // energy regen
    const energy = Math.min(
      this.config.energyMax,
      (this.store.kvGet('energy') || 0) + this.config.energyRegen * dt,
    );
    this.store.kvSet('energy', energy);

    this.expireSignals(now);
  }

  expireSignals(now) {
    const currentTopic = this.store.kvGet('current_topic') || '';
    for (const s of this.store.signals('active')) {
      if (now - s.ts >= s.max_lifetime) {
        this.resolveOne(s, 'expired', now);
      } else if (s.confidence < this.config.confidenceFloor) {
        this.resolveOne(s, 'low_confidence', now);
      } else if (s.topic && s.topic !== currentTopic) {
        const lastSeen = this.store.kvGet(`topic_seen:${s.topic}`) ?? s.ts;
        if (now - lastSeen > this.config.topicAbandonAfter) {
          this.resolveOne(s, 'abandoned', now);
        }
      }
    }
  }

  // -- satisfaction -----------------------------------------------------------

  /** Externally-observed resolution: someone else solved it, the user
   * declined, the goal completed. Discharges the associated pressure. */
  resolve(now, reason, { topic = null, key = null } = {}) {
    let count = 0;
    for (const s of this.store.signals('active')) {
      if (key !== null && s.key !== key) continue;
      if (key === null && topic !== null && s.topic !== topic) continue;
      this.resolveOne(s, reason, now);
      count += 1;
    }
    return count;
  }

  /** Mark resolved and discharge its remaining charge from its bucket. */
  resolveOne(s, reason, now) {
    const remaining = strength(s, now);
    resolveSignal(s, reason, now);
    this.store.upsertSignal(s);
    const routed = this.config.sourceRouting[s.source];
    if (routed) {
      const [bucketName] = routed;
      const cfg = this.config.buckets[bucketName];
      const pressures = this.store.getPressures();
      pressures[bucketName] = Math.max(0, pressures[bucketName] - cfg.gain * remaining);
      this.store.setPressures(pressures);
    }
  }

  // -- relevance-scoped pressure ----------------------------------------------

  /** Bucket pressure scaled by how much of its live signal strength is about
   * this topic — pressure about other things doesn't justify speaking about
   * this one. */
  topicPressure(bucket, topic, now) {
    const pressures = this.store.getPressures();
    let totalStrength = 0;
    let topicStrength = 0;
    for (const s of this.store.signals('active')) {
      const routed = this.config.sourceRouting[s.source];
      if (!routed || routed[0] !== bucket) continue;
      const value = strength(s, now);
      totalStrength += value;
      if (s.topic === topic) topicStrength += value;
    }
    if (totalStrength <= 0) return 0;
    return (pressures[bucket] || 0) * (topicStrength / totalStrength);
  }

  /** Live (bucket, topic) pairs ranked by how far past threshold their
   * topic-scoped pressure is; includes where the latest signal was seen. */
  candidates(now) {
    const latest = new Map();
    for (const s of this.store.signals('active')) {
      if (strength(s, now) <= 0) continue;
      const routed = this.config.sourceRouting[s.source];
      if (!routed) continue;
      const key = `${routed[0]} ${s.topic}`;
      // The pair is carried in the value, not parsed back out of the key —
      // a topic can contain spaces ("tabs vs spaces"), and splitting a
      // joined key would silently truncate it.
      const previous = latest.get(key);
      if (!previous || s.ts > previous.signal.ts) {
        latest.set(key, { bucket: routed[0], topic: s.topic, signal: s });
      }
    }
    const out = [];
    for (const { bucket, topic, signal: s } of latest.values()) {
      out.push({
        bucket,
        topic,
        channelId: s.channel_id,
        userId: s.user_id,
        pressure: this.topicPressure(bucket, topic, now),
        threshold: this.config.buckets[bucket].threshold,
      });
    }
    out.sort((a, b) => (b.pressure - b.threshold) - (a.pressure - a.threshold));
    return out;
  }

  // -- the gate ---------------------------------------------------------------

  evaluate(proposal, now, record = true) {
    let topicState = 'active';
    const live = this.store.signals('active')
      .filter((s) => s.topic === proposal.topic && strength(s, now) > 0);
    if (!live.length) {
      const resolved = this.store.signals(null)
        .filter((s) => s.topic === proposal.topic && s.state !== 'active');
      topicState = resolved.length ? resolved[resolved.length - 1].state : 'expired';
    }
    return this.gate.evaluate({
      proposal,
      now,
      pressures: this.store.getPressures(),
      topicPressure: this.topicPressure(proposal.bucket, proposal.topic, now),
      exchangeActive: this.exchangeActive(now, proposal.channelId),
      energy: this.store.kvGet('energy') || 0,
      topicState,
      record,
    });
  }

  // -- discharge ---------------------------------------------------------------

  /** After Max actually speaks: discharge, record, cool down. */
  recordSpoken(proposal, now) {
    const cfg = this.config.buckets[proposal.bucket];
    const pressures = this.store.getPressures();
    pressures[proposal.bucket] = Math.max(0, pressures[proposal.bucket] * (1 - cfg.releaseFraction));
    this.store.setPressures(pressures);

    for (const s of this.store.signals('active')) {
      if (s.topic === proposal.topic) {
        resolveSignal(s, 'spoken', now);
        this.store.upsertSignal(s);
      }
    }

    this.store.addContribution(makeContribution({
      ts: now,
      topic: proposal.topic,
      bucket: proposal.bucket,
      content_key: proposal.contentKey,
      summary: proposal.summary,
      channel_id: proposal.channelId,
    }), this.config.maxContributionsKept);
    this.cooldowns.startAll(now, proposal.channelId, proposal.userId, proposal.topic);
    this.store.kvSet('energy', Math.max(
      0, (this.store.kvGet('energy') || 0) - this.config.energyCost,
    ));
  }

  // -- inspection ---------------------------------------------------------------

  snapshot(now) {
    const cooldowns = {};
    for (const [k, v] of Object.entries(this.store.getCooldowns())) {
      if (v > now) cooldowns[k] = Math.round((v - now) * 10) / 10;
    }
    return {
      pressures: this.store.getPressures(),
      energy: this.store.kvGet('energy'),
      activeSignals: this.store.signals('active').map((s) => ({
        key: s.key,
        source: s.source,
        topic: s.topic,
        strength: Math.round(strength(s, now) * 1e4) / 1e4,
        evidence: s.evidence,
      })),
      cooldowns,
      contributions: this.store.contributions().length,
      decisions: this.store.decisions().length,
    };
  }
}
