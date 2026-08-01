# Gudda-Ingestion Branch Integration Checklist

> Detailed phase-by-phase implementation plan and progress tracker for integrating **GuddaLM** hyperdimensional cognitive capabilities (VSA/HDC, fast signal classification, SDM memory, and event sentinel) into **discord-agent**.

---

## Phase 0: Maturin Toolchain & Environment Setup
**Target**: Python Environment / `requirements.txt`

- [x] **0.1 System Inspection**
  - Check for `maturin` in Python environment (`pip show maturin` / `maturin --version`).
- [x] **0.2 Maturin Installation**
  - Install `maturin` via `pip install maturin` (or `cargo install maturin`).
  - Add `maturin>=1.5.0` to `requirements.txt` under optional/development build tools.
- [x] **0.3 Native Module Build Verification**
  - Verify `maturin develop` or PyO3 wheel generation capability in `c:\\Users\\zoddj\\GuddaLM`.
  - Native `.pyd` exists at `C:\Users\zoddj\GuddaLM\python\guddalm\_native.cp311-win_amd64.pyd`

---

## Phase 1: GuddaLM Python Bridge & Vector Encoding Engine
**Target File**: `gudda_bridge.py`

- [x] **1.1 Native & Fallback Loader**
  - Attempt PyO3 native import from `c:\\Users\\zoddj\\GuddaLM\\python\\guddalm` (`_native.pyd`).
  - Provide complete pure-Python `HDVector` class fallback (bipolar $\pm 1$ and binary BSC $0/1$) if native module is absent.
- [x] **1.2 N-Gram Text Hypervector Encoder**
  - Implement deterministic n-gram char/word permutation tokenizer (`encode_text(text: str, dim: int = 10000)`).
- [x] **1.3 Role-Filler Binding Operator**
  - Implement XOR role-filler binding (`encode_turn(speaker: str, text: str, timestamp: float, source: str)`).
- [x] **1.4 Vector Similarity Helper**
  - Provide fast Cosine Similarity and XNOR-Popcount Similarity calculation helpers ($O(N)$ SIMD-aligned).

---

## Phase 2: Proactive Engine Signal Pre-Classification
**Target File**: `bot/cogs/proactive.py`

- [x] **2.1 Prototype Signal Vectors**
  - Define trained prototype vectors for signals: `incorrect_claim`, `blocker`, `safety_concern`, `promised_followup`.
- [x] **2.2 Pre-Classification Vector Gate**
  - Add fast HD vector similarity check in `_classify_and_ingest` before calling the OpenRouter LLM.
- [x] **2.3 SDM Threshold Calibration**
  - Set similarity threshold based on Sparse Distributed Memory noise radius ($d^*_{SNR} = N/2 - \sqrt{N/2}$).
- [x] **2.4 Token Spend & Latency Optimization**
  - Skip background LLM classification calls when vector similarity is below the signal threshold (reducing LLM API calls by 90%+).
- [x] **2.5 Diagnostic Logging**
  - Log HD pre-classification scores and skipped LLM invocations to `logbuffer`.

---

## Phase 3: HD Memory Ingestion & Zero-Latency Retrieval
**Target Files**: `memory.py`, `db.py`

- [x] **3.1 HD Memory Accumulator Store**
  - Create `HDMemoryStore` in `memory.py` managing conjunctive and disjunctive hypervector accumulators per guild.
- [x] **3.2 Turn Vector Ingestion**
  - Update `record_turn()` to encode incoming text and voice turns into hypervectors and update the accumulator.
- [x] **3.3 Vector Database Persistence**
  - Add SQLite schema & persistence functions in `db.py` (`save_hd_memory`, `get_hd_memory`).
- [x] **3.4 Zero-Latency Context Retrieval**
  - Implement `get_hd_context(guild_id, user_id)` for instant speaker profile & topic vector retrieval.
- [x] **3.5 Member Profile Superposition**
  - Superimpose member profile card fields (`goals`, `projects`, `constraints`) into unified member hypervectors.

---

## Phase 4: Event & Raid Anomaly Sentinel
**Target Files**: `sentinel_bridge.py`, `bot/cogs/automod.py`

- [x] **4.1 Sentinel Bridge Adaptor**
  - Adapt GuddaLM's `FlowEncoder` and `NetworkSentinel` pattern into `sentinel_bridge.py`.
- [x] **4.2 Server Event Encoding**
  - Encode Discord server event streams (joins, message rates, mention velocity, channel transitions) into event hypervectors.
- [x] **4.3 Adaptive Baseline Tracking**
  - Maintain an adaptive baseline hypervector accumulator of normal server behavior with exponential decay ($\alpha = 0.98$).
- [x] **4.4 Anomaly Score Calculation**
  - Compute real-time anomaly scores against server baseline vectors for incoming event windows.
- [x] **4.5 Automod Auto-Quarantine Trigger**
  - Hook sentinel alerts into `automod.py` to trigger warnings/quarantine when an anomaly spike indicates a server raid or mention storm.

---

## Phase 5: Test Suite & Verification
**Target File**: `tests/test_gudda_ingestion.py`

- [x] **5.1 Maturin & Gudda Bridge Tests**
  - Verify Maturin toolchain availability and native PyO3 vs pure-Python vector encoding consistency.
- [x] **5.2 Proactive Pre-Classification Tests**
  - Verify prototype signal matching accuracy and threshold gating logic.
- [x] **5.3 HD Memory Tests**
  - Test vector memory accumulation, decay rates, and SQLite round-trip persistence.
- [x] **5.4 Event Sentinel Tests**
  - Test baseline accumulation and anomaly detection on simulated raid event spikes.
- [x] **5.5 Full Test Suite Execution**
  - Run `pytest` across all test files to verify 0 failures and 0 regressions.
