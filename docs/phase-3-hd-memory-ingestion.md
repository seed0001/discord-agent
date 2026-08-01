# Phase 3: HD Memory Ingestion & Zero-Latency Retrieval

**Date:** 2026-07-25  
**Branch:** `Gudda-Ingestion`  
**Target Files:** `memory.py`, `db.py`, `gudda_bridge.py`

## Goal

Hook every conversation turn ingested via `record_turn()` into hypervector accumulators that enable **instant (zero-IO) similarity queries** against the guild's conversation profile and member identity vectors — replacing most LLM-based retrieval calls.

---

## Architecture

### 3.1 HDMemoryStore (`memory.py`)

Per-guild object holding MAP real-valued accumulators for conjunctive and disjunctive hypervectors, plus per-member profile vectors.

**Conjunctive accumulator (MAP sum):**
- Each turn's BinaryHDVector (BSC 0/1) is converted to MAP (±1) and **added** element-wise to the conjunctive accumulator.
- On query, the MAP sum is **binarized** (sign-threshold: x>0 → 1, else 0) to yield the current majority-rule vector.
- This is correct for N>2 whereas pairwise AND would saturate to all-zeros after ~10 turns.

**Disjunctive accumulator:**
- Same MAP approach, but updated only every 5th turn (sparse — avoids over-weighting high-frequency chatter).

**Profile vectors:**
- Built on demand from profile card fields (`goals`, `active_projects`, `constraints`, `vibe_notes`) via `from_key` + `bundle_all`.
- One-shot superposition, not accumulated.

### 3.2 Turn Vector Ingestion (`memory.py::record_turn()`)

After `_turns[guild_id].append(...)` succeeds:

```python
vec = encode_turn(speaker, text, time.time(), source, dim=HD_DIM)
store.ingest_turn(vec)
if store._save_counter >= SAVE_EVERY:
    _schedule(store.save())
```

- `encode_turn` produces a deterministic BinaryHDVector from speaker name, text, timestamp, and source (text/voice) using role-filler binding.
- Save is scheduled every 25 turns (scheduled async, non-blocking).

### 3.3 SQLite Persistence (`db.py`)

New table `hd_memory(guild_id, kind, dim, bits, updated_at)`:
- `bits` stored as u64-word-packed BLOB (1256 bytes per 10000D vector).
- `save_hd_memory(guild_id, kind, bits, dim)` — INSERT OR REPLACE.
- `get_hd_memory(guild_id, kind)` → (bits, dim) or None.
- On save: binarize MAP → store binary bits. On load: reconstruct MAP from binary (±1), treating it as a "cold restart" (historical weight is lost).

### 3.4 Zero-Latency Context Retrieval (`memory.py::get_hd_context()`)

```python
def get_hd_context(guild_id, user_id=None) -> dict:
    # Returns {"conjunctive": BHDV|None, "disjunctive": BHDV|None, "profile": BHDV|None}
```

All vectors live in-memory after the most recent ingestion — zero I/O.

### 3.5 Member Profile Superposition (`memory.py::_save_profile()`)

After updating a profile card's JSON in SQLite, the store's `set_profile_vector` is called to superpose the four field vectors into a unified member hypervector via `from_key` + `bundle_all`.

---

## Changes Summary

| File | Lines Changed | Nature |
|---|---|---|
| `db.py` | +42 | SCHEMA + `save_hd_memory` + `get_hd_memory` |
| `gudda_bridge.py` | +12 | Fix padding-bit inflation in `xnor_popcount_similarity` for non-64-dim |
| `memory.py` | +150 | `HDMemoryStore` class, `_stores` dict, wiring in `record_turn` and `_save_profile`, `get_hd_context()` |

## Design Decisions

1. **MAP real-valued accumulator** chosen over BSC pairwise AND because AND saturates to all-zeros after ~10 random vectors. MAP sum with sign-threshold preserves the majority correctly for any N.
2. **Disjunctive updated every 5th turn** to prevent high-frequency chatter from dominating the union vector.
3. **Binarized persistence** — the MAP sum magnitude is not stored. On reload, the accumulator is cold-restarted from its last binarized state. New turns rebuild the weight.
4. **10000 dimensions** throughout (matching `HD_DIM` in `proactive.py`).

## Verification

26 checks pass:
- pack/unpack roundtrip for 64, 256, 1000, 10000 dimensions
- similarity clamping: identical=1.0, orthogonal=0.0, random ∈ (0,1)
- HDMemoryStore: init, 20-turn ingestion, conjunctive drift, profile superposition/clear
- `get_context()` shape
- `encode_turn` determinism
- serialization roundtrip
- empty store returns all-None
