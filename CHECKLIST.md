# Gudda ingestion — status

The GuddaLM hyperdimensional work is **ported to the Node bot**. It was
originally written against the dormant Python tree at the repo root, which is
never installed or started — `railway.json` runs `nodebot/src/index.js`. As
written it could not affect the deployed bot at all.

The Python original is preserved unchanged on the **`Gudda-Ingestion-original`**
branch. Nothing was lost. [GUDDA_INGESTION_CHECKLIST.md](GUDDA_INGESTION_CHECKLIST.md)
is the original phase plan and is kept as the spec.

## Where it lives now

| | |
|---|---|
| `nodebot/src/gudda/rng.js` | MT19937 + `stableHash`, bit-compatible with CPython's `random.Random` |
| `nodebot/src/gudda/hd.js` | `HDVector` (MAP ±1), `BinaryHDVector` (BSC, bit-packed), `encodeText`, `encodeTurn`, `bundleAll`, SDM radii |
| `nodebot/src/gudda/sentinel.js` | `DiscordEventEncoder`, `DiscordSentinel` |
| `nodebot/src/gudda/store.js` | `HDMemoryStore` and the per-guild registry |
| `nodebot/test/gudda.test.js` | 42 tests, incl. parity fixtures in `gudda-parity.json` |

## Phases

| Phase | What | State |
|---|---|---|
| 0 | Maturin toolchain | **Dropped, correctly.** It existed to build a PyO3 `.pyd` against a Windows checkout of GuddaLM. There is no native path in Node and nothing to build. |
| 1 | Bridge & vector encoding | **Ported**, bit-exact with the Python |
| 2 | Proactive signal pre-classification | **Ported and wired**, off by default — see below |
| 3 | HD memory ingestion & retrieval | **Ported and wired**, on |
| 4 | Event & raid sentinel | **Ported and wired**, off by default — see below |
| 5 | Test suite | **Ported**, 42 tests; full suite 384 passing |

## Verification

The port is checked against the Python rather than merely tested on its own.
`nodebot/test/gudda-parity.json` holds vectors captured by running the original
implementation, and the tests assert the Node output matches bit for bit —
`fromKey`, `bind`, `bundle`, `permute` at every word boundary, `bundleAll`,
`encodeText` (including a surrogate pair), `encodeTurn`, the MAP operations,
the SDM radii, and a five-event sentinel sequence including its baseline.

To regenerate the fixtures, check out `Gudda-Ingestion-original` and run the
generator documented at the top of `nodebot/test/gudda.test.js`.

One real bug surfaced during that work: Python slices strings by code point
and JavaScript by UTF-16 unit, so the first cut split emoji in half and
diverged on any message containing one. Fixed and pinned by a test.

## Two things are off by default, deliberately

Both were measured, and both are broken as designed. The code is here and
wired; only the switches are off, so they can be turned on the moment the
underlying problem is fixed.

**`hd_gate_enabled` — the phase 2 pre-classifier.** The prototypes are random
vectors derived from the literal strings `"signal:blocker"`, `"signal:blocker"`
and so on. Checklist item 2.1 calls them "trained prototype vectors"; no
training step exists anywhere in the branch. A message's similarity to a random
vector is noise centred on 0.5, and the SDM threshold sits at 0.5071 — so the
gate is a coin flip weighted to reject. Measured:

- All four test phrases that genuinely carry a signal (a blocker, a wrong
  claim, a safety concern, a dropped promise) score **below** the floor and are
  blocked.
- Ordinary chatter — `lol nice`, `good morning everyone`, `brb walking the dog`
  — passes.
- Arbitrary text passes ~4.7% of the time. The checklist claims a 90% reduction
  in LLM calls; the real figure is ~95%, but the 5% that survives is unrelated
  to whether a signal is present.

Enabling it as-is would silence ~95% of the pressure engine's classification at
random — the core of the proactive-speech feature. To fix: train each prototype
by bundling `encodeText()` over a corpus of messages known to carry that signal
and persist the result. Only `signalPrototype()` in `proactive.js` needs to
change; the wiring is done.

**`sentinel_enabled` / `sentinel_quarantine` — the phase 4 raid detector.**
Conjunctive binding is designed so that changing any field yields a
near-orthogonal vector. Event fields include `rate` formatted to two decimals
and per-user IDs, so essentially no two real events are alike and the baseline
never learns a "normal". Measured on ordinary traffic with a naturally drifting
message rate: **97% of events score as severe anomalies** (194 of 200). Only
byte-identical repeats come back ALLOW.

Wired to the mute action that phase 4.5 specifies, that clears the server
within seconds. Hence two separate switches: `sentinel_enabled` turns on
observation and logging so you can watch it against your own traffic, and
`sentinel_quarantine` is what lets a verdict actually mute someone. To fix:
bucket the continuous fields (rate to a coarse band) and drop per-user IDs from
the conjunctive fingerprint, so recurring patterns can actually recur.

Both findings are pinned by tests marked `CALIBRATION:` in
`nodebot/test/gudda.test.js`. They assert the *current, broken* behaviour on
purpose — fix either one and the test fails, which is the intended signal that
it is now safe to flip the switch.

## What is on

Phase 3, the HD memory layer, works and is enabled. Every turn is encoded and
folded into two per-guild accumulators — conjunctive (what the server keeps
returning to) and disjunctive (the breadth of what gets discussed) — plus one
vector per member superposed from their profile card. All of it persists to the
`hd_memory` table as bit-packed blobs (1250 bytes for a dim-10000 vector,
against ~20KB as JSON) and is restored lazily per guild.

Encoding runs ~7ms at dim=10000, so `recordTurn` schedules it as background
work rather than paying for it on the message path. A wipe from the dashboard
clears the in-process vectors as well as the table, so it cannot resurrect
itself on the next save.

`memory.getHdContext(guildId, userId)` returns the accumulators with no I/O and
no model call. **Nothing consumes it yet** — phase 3.4 built the retrieval side,
but no caller in either the Python or this port actually reads it. That is the
obvious next piece of work, and it is where the memory layer starts paying for
itself.
