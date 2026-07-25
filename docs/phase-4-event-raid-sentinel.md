# Phase 4: Event & Raid Anomaly Sentinel

**Date:** 2026-07-25  
**Branch:** `Gudda-Ingestion`  
**Target Files:** `sentinel_bridge.py`, `bot/cogs/automod.py`

## Goal

Adapt GuddaLM's `NetworkSentinel` pattern (MAP-valued `FlowEncoder` + adaptive baseline with exponential decay) to Discord server events — detecting message bursts, mention storms, mass joins, and channel-hopping raids via real-time hyperdimensional anomaly scoring.

---

## Architecture

### 4.1 DiscordEventEncoder (`sentinel_bridge.py`)

Encodes a Discord event as a MAP (±1) hypervector via role-filler binding:

```
event_vector = bind(role_user_id, filler("42"))
            ⊗ bind(role_rate, filler("0.8"))
            ⊗ bind(role_event_type, filler("MESSAGE_BURST"))
```

- **Role vectors** — pre-generated deterministically per field name (e.g. `role:rate`, `role:user_id`).
- **Filler vectors** — deterministic `HDVector.from_key(f"filler:{value}")` per field value.
- **Conjunctive** — product (bind) of all role⊗filler pairs → full event fingerprint.
- **Disjunctive** — sum (bundle) of all bound pairs → supports attribute-level diagnostics.

**Event types & fields:**

| Event | Fields |
|---|---|
| `MEMBER_JOIN` | user_id, role_count |
| `MEMBER_LEAVE` | user_id, presence_seconds |
| `MESSAGE_BURST` | channel_id, rate (msgs/sec), window_seconds |
| `MENTION_STORM` | target_user_id, mention_count, source_count |
| `CHANNEL_HOP` | user_id, from_channel, to_channel, interval_seconds |

### 4.2 DiscordSentinel (`sentinel_bridge.py`)

Maintains a floating-point baseline accumulator (dim=10000) with exponential decay:

```
S_{t+1} = α · S_t + (1 - α) · event_vector      α = 0.98
```

**`observe(event_type, **fields)` → report dict:**

1. Encode event via `DiscordEventEncoder` → MAP vector
2. If first event: set baseline = event, return `INIT`
3. Compute `anomaly_score = max(0, 1 - cosine_sim(event, baseline))`
4. Thresholds: ALLOW (<0.15) | WARN (0.15–0.35) | QUARANTINE (≥0.35)
5. Update baseline with exponential decay
6. Return `{event_type, similarity, anomaly_score, verdict, message}`

### 4.3 Automod Integration (`bot/cogs/automod.py`)

- Per-guild `DiscordSentinel` instances (lazy-created).
- **Message rate tracking:** deque of timestamps per channel; on each `on_message`, prune stale, feed `MESSAGE_BURST` if rate > 0.5 msg/s in 10s window.
- **Mention storm tracking:** deque of `(source_id, ts)` per target user; feed `MENTION_STORM` if >3 unique sources in 10s.
- **`on_member_join`:** feed `MEMBER_JOIN` event (user_id, current guild member count).
- **Actions:** WARN → log + optional mod ping; QUARANTINE → temporary mute (10 min) + log.

## Changes Summary

| File | Lines | Nature |
|---|---|---|
| `sentinel_bridge.py` | ~200 | New — `DiscordEventEncoder` + `DiscordSentinel` |
| `bot/cogs/automod.py` | ~+80 | Add sentinel instance, rate tracking, event hooks, anomaly actions |

## Verification (ad-hoc)

- standalone logic tests: encode determinism, cosine similarity, baseline decay, anomaly scoring
- automod integration requires `discord` package (Railway only) — syntax compilation verified locally
