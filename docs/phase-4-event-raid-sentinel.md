# Phase 4: Event & Raid Anomaly Sentinel

**Status:** wired, default **off** (both switches). Calibration-tested to
pin the current, known-broken behavior — see Verification below.
**Files:** `nodebot/src/gudda/sentinel.js`, `nodebot/src/automod.js`,
`nodebot/src/db.js`.

## Goal

Adapt GuddaLM's `NetworkSentinel` pattern (a MAP-valued flow encoder plus an
adaptive baseline with exponential decay) to Discord server events —
detecting message bursts, mention storms, and join spikes via real-time
hyperdimensional anomaly scoring.

---

## Architecture

### 4.1 `DiscordEventEncoder` (`nodebot/src/gudda/sentinel.js`)

Encodes a Discord event as a MAP (±1) hypervector via role-filler binding:

```
event_vector = bind(role_user_id,    filler("42"))
             ⊗ bind(role_rate,       filler("0.80"))
             ⊗ bind(role_event_type, filler("MESSAGE_BURST"))
```

- **Role vectors** — deterministic per field name (e.g. `role:rate`,
  `role:user_id`), drawn from `EVENT_FIELDS`.
- **Filler vectors** — deterministic `HDVector.fromKey('filler:' + value)`
  per field value.
- **Conjunctive** fingerprint — product (bind) of all role⊗filler pairs.
- **Disjunctive** — sum (bundle) of the same pairs, for attribute-level
  diagnostics.

Event types and their fields (`EVENT_FIELDS`): `MEMBER_JOIN` (user_id,
role_count), `MESSAGE_BURST` (channel_id, rate, window_seconds),
`MENTION_STORM` (target_user_id, mention_count, source_count).

### 4.2 `DiscordSentinel` (`nodebot/src/gudda/sentinel.js`)

Maintains a floating-point baseline accumulator (dim=10000) with exponential
decay:

```
S(t+1) = ALPHA · S(t) + (1 - ALPHA) · event_vector      ALPHA = 0.98
```

`observe(eventType, fields)`:
1. Encode the event via `DiscordEventEncoder` → MAP vector.
2. If this is the first event for the guild: set baseline = event, return
   `INIT`.
3. Compute `anomaly = max(0, 1 - cosineSimilarity(event, baseline))`.
4. Verdict thresholds: `ALLOW` (< `ANOMALY_WARN` = 0.15) | `WARN`
   (0.15–0.35) | `QUARANTINE` (≥ `ANOMALY_QUARANTINE` = 0.35).
5. Update the baseline with the same exponential decay.
6. Return `{ eventType, similarity, anomalyScore, verdict, message }`.

### 4.3 Automod integration (`nodebot/src/automod.js`)

- Per-guild `DiscordSentinel`, created lazily (`sentinelFor`).
- **Message rate:** a timestamp list per channel; on every clean message,
  prune anything older than `RATE_WINDOW` (10s) and feed `MESSAGE_BURST` if
  the rate exceeds `RATE_THRESHOLD` (0.5 msg/s).
- **Mention storms:** a `(sourceId, ts)` list per mention target; feed
  `MENTION_STORM` once `STORM_SOURCE_THRESHOLD` (3) distinct mentioners hit
  a target within `STORM_WINDOW` (10s).
- **Member joins:** `checkMemberJoin(member)`, called from the
  `GuildMemberAdd` handler in `nodebot/src/index.js`, feeds `MEMBER_JOIN` —
  kept in a separate `try/catch` from the welcome message so a join is still
  observed even if the welcome send fails.
- **Actions:** `WARN`/`QUARANTINE` are logged (`console.log`). A
  `QUARANTINE` verdict only *acts* — adding a `muted` role and posting to
  the mod log — when `sentinel_quarantine` is also on. There is no
  auto-unmute timer; the role assignment is indefinite, same as any other
  manual mute in this bot, and removal is a moderator action.

### 4.4 Two switches, deliberately separate

- `sentinel_enabled` — turns on observation and logging only.
- `sentinel_quarantine` — lets a `QUARANTINE` verdict actually mute someone.

Both default `false`. The split exists because the scoring is not
calibrated for continuously-varying fields: conjunctive binding makes any
change to any field (including a rate formatted to two decimals drifting
from 0.50 to 0.51) produce a near-orthogonal vector. Measured on ordinary
traffic, ~97% of events score as `QUARANTINE` — enabling the mute action as
shipped would clear the server. Fixing this means bucketing the continuous
fields (e.g. rate into coarse bands) and dropping per-user IDs from the
fingerprint, so the baseline can actually learn what "normal" looks like.
Until then, `sentinel_enabled` alone is a measurement tool: watch the logs
on real traffic before ever turning on `sentinel_quarantine`.

---

## Verification

`nodebot/test/gudda.test.js`, run via `npm test` in `nodebot/`: encode
determinism, cosine similarity bounds, baseline decay, a five-event sentinel
sequence (including its `INIT` baseline) pinned bit-for-bit against fixtures
captured from the Python original. One test is marked **CALIBRATION**: it
pins the current ~97%-false-positive behavior on purpose, so that the day
someone fixes the field bucketing, the test fails — which is the signal
that `sentinel_quarantine` is safe to turn on for real.
