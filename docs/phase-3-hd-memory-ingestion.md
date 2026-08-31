# Phase 3: HD Memory Ingestion & Zero-Latency Retrieval

**Status:** live, default **on**.
**Files:** `nodebot/src/gudda/hd.js`, `nodebot/src/gudda/store.js`,
`nodebot/src/memory.js`, `nodebot/src/db.js`.

This is the GuddaLM hyperdimensional layer, originally written in Python
against the dormant bot tree at the repo root (preserved on
`origin/Gudda-Ingestion-original`) and ported bit-exact to the Node bot on
`origin/gudda-node-port`, then integrated here.

## Goal

Hook every conversation turn recorded via `memory.recordTurn()` into
hypervector accumulators that support **instant, zero-I/O similarity
queries** against a guild's conversation profile and member identity
vectors, as an alternative to LLM-based retrieval for that kind of question.

---

## Architecture

### 3.1 `HDMemoryStore` (`nodebot/src/gudda/store.js`)

Per-guild object holding MAP real-valued accumulators for conjunctive and
disjunctive hypervectors, plus per-member profile vectors.

**Conjunctive accumulator (MAP sum):**
- Each turn's `BinaryHDVector` (BSC 0/1) is converted to MAP (±1) and
  **added** element-wise to the conjunctive accumulator.
- On query, the MAP sum is **binarized** (sign-threshold: x>0 → 1, else 0)
  to yield the current majority-rule vector.
- This is correct for N>2, whereas pairwise AND (via BSC bind) would
  saturate to all-zeros after ~10 turns.

**Disjunctive accumulator:**
- Same MAP approach, but updated only every 5th turn (sparse — avoids
  over-weighting high-frequency chatter).

**Profile vectors:**
- Built on demand from profile card fields (`goals`, `active_projects`,
  `constraints`, `vibe_notes`) via `fromKey` + `bundleAll`.
- One-shot superposition, not accumulated.

### 3.2 Turn vector ingestion (`nodebot/src/memory.js`)

`recordTurn()` calls `ingestHd()` after the turn is durably written to
`db.turns`:

```js
function ingestHd(gid, speaker, body, source, ts) {
  schedule(() => {
    const store = hydratedStore(gid);
    store.ingestTurn(encodeTurn(speaker, body, ts, source, HD_DIM));
    if (store.needsSave) store.save(db);
  });
}
```

- `encodeTurn` produces a deterministic `BinaryHDVector` from speaker name,
  text, timestamp, and source (text/voice) using role-filler binding.
  Timestamps bucket to the hour (`timeBucketSec` default) rather than the
  millisecond, so two turns in the same hour actually share signal.
- Scheduled as a microtask, not inline — encoding at dim=10000 costs ~7ms of
  CPU, and `recordTurn` sits on the path of every message. Non-fatal: a
  failed encode never costs the turn itself, which is already persisted by
  this point.
- Save is scheduled every `SAVE_EVERY` (25) turns.

### 3.3 SQLite persistence (`nodebot/src/db.js`)

Table `hd_memory(guild_id, kind, dim, bits, updated_at)`:
- `bits` stored bit-packed (`packBits`/`unpackBits` in `gudda/hd.js`) —
  1250 bytes for a dim=10000 vector, against ~20KB as a JSON array of 0/1.
  Packing is little-endian, bit *i* at byte *i>>3*, matching what the Python
  original wrote — a blob is readable by either implementation.
- `saveHdMemory` / `getHdMemory` — upsert / point lookup by `(guildId, kind)`.
- `allHdMemory(guildId)` — every stored vector for a guild, used to restore
  profile vectors, whose `kind` (`profile:<userId>`) isn't known in advance.
- On save: binarize the MAP accumulator → store binary bits. On load:
  reconstruct MAP from binary (±1) — a "cold restart"; the accumulated
  magnitude/weight from before the restart is not preserved, only its sign.
- Hydration is lazy per guild (`memory.js`'s `hydratedStore`), so a bot in
  many guilds only pays for the ones that actually talk. A dashboard memory
  wipe (`DELETE /api/guilds/:guildId/memory`) calls `memory.forgetHd()` to
  drop the in-process store too, so it isn't silently resurrected on the
  next scheduled save.

### 3.4 Zero-latency context retrieval

```js
export function getHdContext(guildId, userId = null) {
  return hydratedStore(guildId).getContext(userId);
}
```

Returns `{ conjunctive, disjunctive, profile }`, any of which may be `null`
before enough turns have landed. All vectors are already in memory — no I/O
on the read path.

**Nothing consumes `getHdContext` itself** (the conjunctive/disjunctive
accumulators) — it stays infrastructure. The one thing that was tried
against it (gating the proactive-speech classifier on relevance to live
context) didn't pan out: turn-level vectors separate relevant from
irrelevant drafts by only ~0.04 against ~0.26 at plain text level, because
`encodeTurn` binds four role-filler pairs and only one of them is the text
itself. See the block comment above `hdPreclassify` in
`nodebot/src/proactive.js` and the "Fix two encoder defects" commit for the
measurements. There is a real consumer now, but it's built on a different
structure — see 3.5.

### 3.5 Resonance — a real consumer, on a different structure

`getContext()` (`nodebot/src/memory.js`, injected into the system prompt
every reply) now includes an optional line:

```
[RESONANT MEMORY — a loose echo from earlier here, not a quote or a fact]
jordan said something in a similar vein a while back: "we should really
add an index on guild_id and seq"
```

The first attempt at this used a third accumulator built the same way as
conjunctive/disjunctive — bundle `encodeText()` of every turn into one
running sum. Measured (see `gudda.test.js`), it didn't work: bundling more
than a handful of *different* messages saturates, and a same-topic query can
score *lower* against the result than an unrelated one does — the sum ends
up dominated by whatever's frequent across everything (common short words),
not what's distinctive to any one topic. This is the same capacity problem
that broke the phase 2 gate, one layer over.

What's actually deployed instead, in `HDMemoryStore.recentText`
(`gudda/store.js`): a bounded window (`RECENT_TEXT_CAP` = 150) of individual,
*unbundled* `encodeText()` vectors, one per recent turn, kept alongside the
accumulators rather than folded into them. A query finds its single best
match by direct pairwise comparison — nearest-neighbor, not summation — which
is the shape of comparison that was actually measured to carry signal
(`encodeText separates same-topic from different-topic text`, 0.7679 vs
0.5110 for two individual texts). On a small hand-built corpus, best-match
scores for on-topic queries land at 0.588–0.606 and for unrelated queries at
0.529–0.569 — a real but modest gap (~0.02), not a clean separation.
`RESONANCE_THRESHOLD` (0.58, in `memory.js`) sits between them, biased
slightly toward the on-topic side: staying quiet on a genuine match costs
less than speaking up about something unrelated.

Mechanics:
- `recordTurn()` → `ingestHd()` calls `store.recordRecentText(seq, speaker,
  body)` alongside the existing `ingestTurn()` call, on the same scheduled
  microtask.
- The window is **not** persisted to `hd_memory` — it's rebuilt from
  `db.turns` (already permanent) lazily, the first time a guild's store is
  touched after a restart, via `store.seedRecentText()`. This runs on its own
  scheduled microtask, separate from the (synchronous, cheap) accumulator
  restore in `hydratedStore` — encoding ~150 past turns costs about a second
  of CPU, and that must never block the reply path that first touches the
  guild.
- `getContext()` reads the current turn from its own in-process buffer (the
  turn was just recorded moments earlier in the same handler) and calls
  `store.findResonant(text, { beforeSeq })`, excluding anything within the
  last 40 turns — the deepest of textChat's `HISTORY_LIMIT` and voice's
  `CONTEXT_TURNS` — so a hit only ever surfaces something not already visible
  in the model's own transcript.
- Never a fact, never specifics beyond the one matched line — the framing in
  the injected text is deliberate.

### 3.6 Member profile superposition

After `memory.js`'s `saveProfile()` writes a profile card's JSON to SQLite,
it calls `store.setProfileVector(userId, fields)`, which superposes the
field vectors into one member hypervector via `fromKey` + `bundleAll`.

---

## Design decisions

1. **MAP real-valued accumulator** chosen over BSC pairwise AND/bind,
   because AND saturates to all-zeros after ~10 random vectors. MAP sum with
   sign-threshold preserves the majority correctly for any N.
2. **Disjunctive updated every 5th turn** to prevent high-frequency chatter
   from dominating the union vector.
3. **Binarized persistence** — the MAP sum's magnitude isn't stored. Reload
   cold-restarts the accumulator from its last binarized state; new turns
   rebuild the weight from there.
4. **10000 dimensions** throughout (`HD_DIM` / `DEFAULT_DIM` in `gudda/hd.js`
   and `gudda/store.js`).
5. **Resonance is a list, not an accumulator** — see 3.5. Any future
   "consume the accumulators directly" idea should measure the same way
   (individual comparison vs. a bundled sum) before assuming bundling is fine
   for a given use; it wasn't, twice now (phase 2's gate, this).

## Verification

`nodebot/test/gudda.test.js`, run via `npm test` in `nodebot/`:
- pack/unpack roundtrip at several dimensions
- similarity bounds: identical=1.0, orthogonal≈0.0, random ∈ (0,1)
- `HDMemoryStore`: init, multi-turn ingestion, conjunctive drift, profile
  superposition/clear, `getContext()` shape
- `encodeTurn` / `encodeText` determinism
- SQLite bit-packing roundtrip
- parity fixtures (`gudda-parity.json`) pin the Node output bit-for-bit
  against the original Python, generated by actually running it
- resonance: `findResonant`/`recordRecentText`/`seedRecentText` behavior
  (cap eviction, `beforeSeq` exclusion, sorted rebuild), the topic-attribution
  measurement, and the on-topic-vs-unrelated threshold measurement behind
  `RESONANCE_THRESHOLD`

`nodebot/test/memory.test.js` covers the integration: `getContext()` surfaces
a resonant match buried outside the visible transcript, stays silent when
nothing resonates, and never throws before the resonance window has finished
its background seed.
