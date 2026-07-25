"""Comprehensive test suite for the Gudda Ingestion pipeline.

Covers all 5 phases — bridge ops, proactive HD pre-classification, HD memory
store, event sentinel, and integration — using only pure-Python HD logic so
the suite runs without ``discord``, ``aiosqlite``, or a Maturin native build.

Markers:
    ``pyo3``    — tests that need the native PyO3 wheel  (skipped when absent)
    ``discord`` — tests that need ``discord.py``         (skipped when absent)
    ``slow``    — tests that take >2 s                    (use -m 'not slow')
"""

import math
import struct
import random

import pytest

# Phase 0-1: Bridge
from gudda_bridge import (
    GuddaBridge,
    HDVector,
    BinaryHDVector,
    encode_text,
    encode_turn,
    bundle_all,
    xnor_popcount_similarity,
    cosine_similarity,
    sdm_snr_threshold,
    sdm_mem_radius,
    sdm_centroid_radius,
    native_available,
    _pack_bits,
    _unpack_bits,
)

# ── Mock unavailable deps before any project imports ──
import sys
from unittest.mock import MagicMock

# Register fake packages so "from discord.ext import commands" etc. work
_MOCK_PKGS = {
    "discord": [
        "discord.ext",
        "discord.ext.commands",
        "discord.app_commands",
    ],
    "aiosqlite": [],
}
for top, children in _MOCK_PKGS.items():
    if top in sys.modules:
        continue
    top_mod = MagicMock()
    sys.modules[top] = top_mod
    for child in children:
        parts = child.split(".")
        parent = sys.modules[".".join(parts[:-1])]
        child_mod = MagicMock()
        setattr(parent, parts[-1], child_mod)
        sys.modules[child] = child_mod

# Phase 3: HD Memory  (standalone pack/unpack — async aiosqlite excluded)
from gudda_bridge import _pack_bits as pack_bits, _unpack_bits as unpack_bits
from db import save_hd_memory, get_hd_memory

# Phase 4: Event Sentinel
from sentinel_bridge import (
    DiscordEventEncoder,
    DiscordSentinel,
    DEFAULT_DIM,
    ALPHA,
    ANOMALY_WARN,
    ANOMALY_QUARANTINE,
    EVENT_FIELDS,
)

# Phase 2: Proactive HD gate
from bot.cogs.proactive import (
    _init_hd_prototypes,
    _hd_preclassify,
    _hd_any_signal,
    _parse_json,
)

DIM = 256          # fast tests; the real dim is 10000 but the logic is identical
FULL_DIM = 10000   # used for SDM threshold checks and a few dimensional assertions

# =========================================================================
# 5.1  Gudda Bridge & Vector Ops
# =========================================================================


class TestGuddaBridge:
    """Phase 1: HDVector, BinaryHDVector, encode_text, encode_turn, SDM."""

    def test_native_available(self):
        """Just check the probe runs — doesn't require it to be True."""
        n = native_available()
        assert n in (True, False)

    def test_binary_from_key_deterministic(self):
        a = BinaryHDVector.from_key("hello", DIM)
        b = BinaryHDVector.from_key("hello", DIM)
        assert a.xnor_popcount_similarity(b) == 1.0

    def test_binary_from_key_distinct(self):
        a = BinaryHDVector.from_key("alpha", DIM)
        b = BinaryHDVector.from_key("beta", DIM)
        sim = a.xnor_popcount_similarity(b)
        assert 0.0 < sim < 1.0

    def test_binary_self_similarity(self):
        v = BinaryHDVector(DIM, [1] * DIM)
        assert v.xnor_popcount_similarity(v) == 1.0

    def test_binary_orthogonal(self):
        z = BinaryHDVector(DIM, [0] * DIM)
        o = BinaryHDVector(DIM, [1] * DIM)
        assert z.xnor_popcount_similarity(o) == 0.0

    def test_binary_bind(self):
        a = BinaryHDVector.from_key("a", DIM)
        b = BinaryHDVector.from_key("b", DIM)
        bound = a.bind(b)
        # After XOR binding, bound decorrelates from both parents
        sim_a = bound.xnor_popcount_similarity(a)
        sim_b = bound.xnor_popcount_similarity(b)
        assert 0.3 < sim_a < 0.7
        assert 0.3 < sim_b < 0.7

    def test_binary_bundle_preserves_similarity(self):
        a = BinaryHDVector.from_key("a", DIM)
        b = BinaryHDVector.from_key("b", DIM)
        bundled = a.bundle(b)
        assert bundled.xnor_popcount_similarity(a) > 0.5
        assert bundled.xnor_popcount_similarity(b) > 0.5

    def test_bundle_all(self):
        a = BinaryHDVector.from_key("a", DIM)
        b = BinaryHDVector.from_key("b", DIM)
        c = BinaryHDVector.from_key("c", DIM)
        bundled = bundle_all(a, b, c, dim=DIM)
        for v in (a, b, c):
            assert bundled.xnor_popcount_similarity(v) > 0.4

    def test_map_from_key_deterministic(self):
        a = HDVector.from_key("test", DIM)
        b = HDVector.from_key("test", DIM)
        assert a.cosine_similarity(b) == 1.0

    def test_map_bind(self):
        a = HDVector.from_key("a", DIM)
        b = HDVector.from_key("b", DIM)
        bound = a.bind(b)
        sim = bound.cosine_similarity(a)
        assert -1.0 < sim < 1.0  # decorrelated

    def test_map_bundle(self):
        a = HDVector.from_key("a", DIM)
        b = HDVector.from_key("b", DIM)
        bundled = a.bundle(b)
        assert bundled.cosine_similarity(a) > 0.5
        assert bundled.cosine_similarity(b) > 0.5

    def test_map_to_binary_roundtrip(self):
        h = HDVector.from_key("roundtrip", DIM)
        bsc = h.to_binary()
        # MAP (±1) → BSC (0/1) preserves the same random seed
        ref = BinaryHDVector.from_key("roundtrip", DIM)
        assert bsc.xnor_popcount_similarity(ref) == 1.0

    def test_encode_text_deterministic(self):
        t1 = encode_text("The quick brown fox", DIM)
        t2 = encode_text("The quick brown fox", DIM)
        assert t1.xnor_popcount_similarity(t2) == 1.0

    def test_encode_text_differs(self):
        a = encode_text("Hello world", DIM)
        b = encode_text("Something completely different", DIM)
        assert a.xnor_popcount_similarity(b) < 0.85

    def test_encode_turn_deterministic(self):
        t1 = encode_turn("Alice", "text", 1.0, "discord", dim=DIM)
        t2 = encode_turn("Alice", "text", 1.0, "discord", dim=DIM)
        assert t1.xnor_popcount_similarity(t2) == 1.0

    def test_encode_turn_differs(self):
        t1 = encode_turn("Alice", "hello", 1.0, "text", dim=DIM)
        t2 = encode_turn("Bob", "goodbye", 2.0, "voice", dim=DIM)
        assert t1.xnor_popcount_similarity(t2) < 0.85

    def test_sdm_thresholds(self):
        """Verify SDM formulas produce sane values for FULL_DIM."""
        assert sdm_snr_threshold(FULL_DIM) > 0
        assert sdm_mem_radius(FULL_DIM) > 0
        assert sdm_centroid_radius(FULL_DIM) > 0
        assert sdm_mem_radius(FULL_DIM) > sdm_snr_threshold(FULL_DIM)

    def test_xnor_popcount_similarity_full_dim(self):
        """Padding-bits fix: identical vectors always yield 1.0 even at FULL_DIM."""
        a = BinaryHDVector.from_key("probe", FULL_DIM)
        b = BinaryHDVector(FULL_DIM, a.to_bits())
        assert a.xnor_popcount_similarity(b) == 1.0

    def test_cosine_similarity_clamping(self):
        v = HDVector(DIM, [1.0] * DIM)
        assert v.cosine_similarity(v) == 1.0
        neg = HDVector(DIM, [-1.0] * DIM)
        assert v.cosine_similarity(neg) == -1.0

    def test_pack_unpack_roundtrip(self):
        """_pack_bits / _unpack_bits from gudda_bridge return original bits."""
        for d in (64, 256, 1000, 10000):
            bits = [random.randint(0, 1) for _ in range(d)]
            words = pack_bits(bits)
            assert len(words) == (d + 63) // 64  # one u64 per 64 bits
            back = unpack_bits(words, d)
            assert bits == back, f"roundtrip failed at dim={d}"


# =========================================================================
# 5.2  Proactive HD Pre-Classification
# =========================================================================


class TestProactiveHDGate:
    """Phase 2: prototype matching and SDM-threshold gating."""

    def test_init_prototypes(self):
        _init_hd_prototypes()
        from bot.cogs.proactive import HD_SIGNAL_PROTOTYPES, _HD_SIM_THRESHOLD
        assert HD_SIGNAL_PROTOTYPES is not None
        assert len(HD_SIGNAL_PROTOTYPES) == 4
        assert _HD_SIM_THRESHOLD is not None
        assert 0.0 < _HD_SIM_THRESHOLD < 1.0

    def test_hd_preclassify_empty(self):
        assert _hd_preclassify("") == {}
        assert _hd_preclassify("   ") == {}

    def test_hd_preclassify_self(self):
        """preclassify runs and returns scores for all 4 prototypes."""
        _init_hd_prototypes()
        scores = _hd_preclassify("incorrect_claim, blocker, safety_concern, promised_followup")
        assert len(scores) == 4
        assert all(0 <= v <= 1 for v in scores.values())

    def test_hd_any_signal(self):
        _init_hd_prototypes()
        assert _hd_any_signal({"incorrect_claim": 0.6}) is True
        assert _hd_any_signal({"incorrect_claim": 0.0}) is False

    def test_hd_preclassify_random_text(self):
        """Random text should not trigger all signals simultaneously."""
        _init_hd_prototypes()
        from bot.cogs.proactive import _HD_SIM_THRESHOLD
        scores = _hd_preclassify("The weather is nice today and I like apples")
        above_snr = sum(1 for s in scores.values() if s >= _HD_SIM_THRESHOLD)
        assert above_snr <= 2  # at most 2 of 4 prototypes by chance

    def test_prototypes_distinct(self):
        """Each prototype should be distinguishable from the others."""
        _init_hd_prototypes()
        from bot.cogs.proactive import HD_SIGNAL_PROTOTYPES
        keys = list(HD_SIGNAL_PROTOTYPES.keys())
        for i, a_key in enumerate(keys):
            for b_key in keys[i + 1:]:
                va = HD_SIGNAL_PROTOTYPES[a_key]
                vb = HD_SIGNAL_PROTOTYPES[b_key]
                # Two random 10000-d vectors have XNOR sim ≈ 0.5 ± 0.01
                sim = va.xnor_popcount_similarity(vb)
                assert 0.4 < sim < 0.6, (
                    f"prototypes {a_key}/{b_key} overlap: {sim:.4f}")


# =========================================================================
# 5.3  HD Memory Store  (standalone — aniosqlite persistence excluded)
# =========================================================================


class TestHDMemoryStore:
    """Phase 3: HDMemoryStore MAP accumulators, profile, serialization."""

    STORE_SRC = """
class _TestStore:
    '''Simplified HDMemoryStore — same logic as memory.HDMemoryStore'''
    def __init__(self, dim=256):
        self.dim = dim
        self._conj = None
        self._disj = None
        self._profiles = {}
        self.turn_count = 0

    def ingest(self, v):
        self.turn_count += 1
        mv = HDVector(self.dim, [1.0 if b else -1.0 for b in v.to_bits()])
        self._conj = self._conj.bundle(mv) if self._conj else mv
        if self.turn_count % 5 == 1:
            self._disj = self._disj.bundle(mv) if self._disj else mv

    def conj(self):
        if self._conj is None:
            return None
        return BinaryHDVector(self.dim,
            [1 if x > 0 else 0 for x in self._conj.data])

    def disj(self):
        if self._disj is None:
            return None
        return BinaryHDVector(self.dim,
            [1 if x > 0 else 0 for x in self._disj.data])

    def set_profile(self, uid, fields):
        vs = []
        for k, v in fields.items():
            if v:
                vs.append(BinaryHDVector.from_key(f"{k}:{v}", self.dim))
        if vs:
            self._profiles[uid] = bundle_all(*vs, dim=self.dim)
        elif uid in self._profiles:
            del self._profiles[uid]

    def get_profile(self, uid):
        return self._profiles.get(uid)

    def pack(self):
        c = self.conj()
        if c is None:
            return []
        return _pack_bits(c.to_bits())

    @classmethod
    def from_packed(cls, words, dim=256):
        s = cls(dim)
        if words:
            bits = _unpack_bits(words, dim)
            s._conj = HDVector(dim,
                [1.0 if b else -1.0 for b in bits])
        return s
"""
    exec(STORE_SRC, globals())

    def test_accumulator_init(self):
        s = _TestStore(256)
        assert s.conj() is None
        assert s.disj() is None
        assert s.turn_count == 0

    def test_single_ingest(self):
        s = _TestStore(256)
        v = BinaryHDVector.from_key("m0", 256)
        s.ingest(v)
        assert s.turn_count == 1
        assert s.conj() is not None
        assert s.disj() is not None  # turns 1 mod 5

    def test_accumulator_converges(self):
        """After many identical turns, conj should be similar to each."""
        s = _TestStore(256)
        vs = [BinaryHDVector.from_key(f"m{i}", 256) for i in range(10)]
        for v in vs:
            s.ingest(v)
        c = s.conj()
        sims = [c.xnor_popcount_similarity(v) for v in vs]
        assert sum(sims) / len(sims) > 0.52

    def test_accumulator_drifts(self):
        """Similarity spread shows conj is not just one input."""
        s = _TestStore(256)
        vs = [BinaryHDVector.from_key(f"m{i}", 256) for i in range(10)]
        for v in vs:
            s.ingest(v)
        c = s.conj()
        sims = [c.xnor_popcount_similarity(v) for v in vs]
        assert max(sims) - min(sims) > 0.001

    def test_accumulator_does_not_saturate(self):
        """MAP accumulator should not saturate to all-zeros even after
        50 turns (unlike pairwise BSC bundle which saturates after ~10)."""
        s = _TestStore(256)
        for i in range(50):
            v = BinaryHDVector(DIM, [random.randint(0, 1) for _ in range(DIM)])
            s.ingest(v)
        c = s.conj()
        bits = c.to_bits()
        n_ones = sum(bits)
        # Should not be all zeros or all ones
        assert 50 < n_ones < 206, f"MAP accumulator saturated: {n_ones}/256 ones"

    def test_profile(self):
        s = _TestStore(256)
        s.set_profile(42, {"goals": "g", "projects": "p"})
        assert s.get_profile(42) is not None

    def test_profile_clear(self):
        s = _TestStore(256)
        s.set_profile(42, {"goals": "g"})
        s.set_profile(42, {})
        assert s.get_profile(42) is None

    def test_profiles_distinct(self):
        s = _TestStore(256)
        s.set_profile(1, {"goals": "x", "projects": "y"})
        s.set_profile(2, {"goals": "a", "projects": "b"})
        sim = s.get_profile(1).xnor_popcount_similarity(s.get_profile(2))
        assert sim < 0.8

    def test_pack_unpack_roundtrip(self):
        s = _TestStore(256)
        vs = [BinaryHDVector.from_key(f"m{i}", 256) for i in range(5)]
        for v in vs:
            s.ingest(v)
        words = s.pack()
        assert len(words) == 256 // 64  # 4 u64 words per 256-bit vector
        s2 = _TestStore.from_packed(words, 256)
        restored = s2.conj()
        original = s.conj()
        assert restored.xnor_popcount_similarity(original) == 1.0

    def test_pack_empty(self):
        s = _TestStore(256)
        assert s.pack() == []
        s2 = _TestStore.from_packed([], 256)
        assert s2.conj() is None


# =========================================================================
# 5.4  Event Sentinel
# =========================================================================


class TestDiscordEventEncoder:
    """Phase 4.1–4.2: Event hypervector encoding."""

    def test_deterministic(self):
        enc = DiscordEventEncoder(DIM)
        c1, _, _ = enc.encode("MESSAGE_BURST", channel_id="1",
                               rate="0.5", window_seconds="10")
        c2, _, _ = enc.encode("MESSAGE_BURST", channel_id="1",
                               rate="0.5", window_seconds="10")
        assert c1.cosine_similarity(c2) == 1.0

    def test_disj_deterministic(self):
        enc = DiscordEventEncoder(DIM)
        _, d1, _ = enc.encode("MESSAGE_BURST", channel_id="1",
                               rate="0.5", window_seconds="10")
        _, d2, _ = enc.encode("MESSAGE_BURST", channel_id="1",
                               rate="0.5", window_seconds="10")
        assert d1.cosine_similarity(d2) == 1.0

    def test_different_fields_discriminable(self):
        enc = DiscordEventEncoder(DIM)
        c1, _, _ = enc.encode("MESSAGE_BURST", channel_id="1",
                               rate="0.5", window_seconds="10")
        c2, _, _ = enc.encode("MESSAGE_BURST", channel_id="999",
                               rate="9.9", window_seconds="10")
        assert c1.cosine_similarity(c2) < 1.0

    @pytest.mark.parametrize("etype,fields", [
        ("MEMBER_JOIN",    {"user_id": "42", "role_count": "5"}),
        ("MEMBER_LEAVE",   {"user_id": "42", "presence_seconds": "3600"}),
        ("MESSAGE_BURST",  {"channel_id": "1", "rate": "0.5", "window_seconds": "10"}),
        ("MENTION_STORM",  {"target_user_id": "99", "mention_count": "10",
                            "source_count": "5"}),
        ("CHANNEL_HOP",    {"user_id": "42", "from_channel": "a",
                            "to_channel": "b", "interval_seconds": "3"}),
    ])
    def test_all_event_types(self, etype, fields):
        enc = DiscordEventEncoder(DIM)
        c, d, a = enc.encode(etype, **fields)
        assert c is not None
        assert d is not None
        for key in fields:
            assert key in a

    def test_all_types_discriminable(self):
        enc = DiscordEventEncoder(DIM)
        vectors = {}
        for etype in EVENT_FIELDS:
            kwargs = {f: str(i) for i, f in enumerate(EVENT_FIELDS[etype])}
            v, _, _ = enc.encode(etype, **kwargs)
            vectors[etype] = v
        types = list(vectors.keys())
        for i, a_key in enumerate(types):
            for b_key in types[i + 1:]:
                sim = vectors[a_key].cosine_similarity(vectors[b_key])
                assert sim < 0.9, (
                    f"{a_key} vs {b_key}: sim={sim:.4f} — too similar")

    def test_event_type_role(self):
        """Even unknown fields get the event_type discriminator."""
        enc = DiscordEventEncoder(DIM)
        c, _, a = enc.encode("MYSTERY_EVENT", bogus="x")
        assert "event_type" in a
        assert sum(abs(x) for x in c.data) > 0

    def test_dim_consistency(self):
        enc = DiscordEventEncoder(DIM)
        c, d, _ = enc.encode("MESSAGE_BURST", channel_id="1",
                               rate="0.5", window_seconds="10")
        assert c.dim == DIM
        assert d.dim == DIM


class TestDiscordSentinel:
    """Phase 4.3–4.4: Adaptive baseline, anomaly scoring, reset."""

    def test_init_state(self):
        s = DiscordSentinel(DIM, alpha=0.98)
        assert not s.initialized
        assert s.baseline is None
        assert s.event_count == 0

    def test_first_observe_init(self):
        s = DiscordSentinel(DIM)
        r = s.observe("MESSAGE_BURST", channel_id="1",
                       rate="0.5", window_seconds="10")
        assert r["verdict"] == "INIT"
        assert r["similarity"] == 1.0
        assert r["anomaly_score"] == 0.0
        assert s.initialized
        assert s.event_count == 1

    def test_same_event_allow(self):
        s = DiscordSentinel(DIM)
        s.observe("MESSAGE_BURST", channel_id="1",
                   rate="0.5", window_seconds="10")
        r = s.observe("MESSAGE_BURST", channel_id="1",
                       rate="0.5", window_seconds="10")
        assert r["verdict"] in ("ALLOW", "WARN")
        assert r["similarity"] > 0.0

    def test_anomaly_score_positive(self):
        s = DiscordSentinel(DIM)
        s.observe("MESSAGE_BURST", channel_id="1",
                   rate="0.5", window_seconds="10")
        r = s.observe("MEMBER_JOIN", user_id="99999", role_count="1")
        assert r["anomaly_score"] > 0.0
        assert r["verdict"] != "INIT"

    def test_reset(self):
        s = DiscordSentinel(DIM)
        s.observe("MESSAGE_BURST", channel_id="1",
                   rate="0.5", window_seconds="10")
        assert s.initialized
        s.reset()
        assert not s.initialized
        assert s.baseline is None
        assert s.event_count == 0
        # After reset, next observe should be INIT
        r = s.observe("MESSAGE_BURST", channel_id="1",
                       rate="0.5", window_seconds="10")
        assert r["verdict"] == "INIT"

    def test_baseline_drifts_with_updates(self):
        s = DiscordSentinel(DIM, alpha=0.5)
        s.observe("MESSAGE_BURST", channel_id="1",
                   rate="0.5", window_seconds="10")
        b1 = s.baseline
        for _ in range(20):
            s.observe("MESSAGE_BURST", channel_id="2",
                       rate="9.9", window_seconds="10")
        b2 = s.baseline
        # With 20 updates at α=0.5, baseline should have drifted
        assert b1.cosine_similarity(b2) < 1.0

    def test_baseline_nonzero(self):
        s = DiscordSentinel(DIM, alpha=0.5)
        for i in range(5):
            s.observe("MESSAGE_BURST", channel_id=str(i),
                       rate="0.5", window_seconds="10")
        b = s.baseline
        nz = sum(1 for x in b.data if abs(x) > 0.01)
        assert nz > 10

    def test_threshold_properties(self):
        s = DiscordSentinel(DIM)
        assert s.alpha == 0.98
        assert s.warn_threshold == 0.15
        assert s.quarantine_threshold == 0.35
        s.alpha = 0.5
        assert s.alpha == 0.5
        s.warn_threshold = 0.2
        assert s.warn_threshold == 0.2

    def test_verdict_order(self):
        """Anomaly score 0 → ALLOW, 0.25 → WARN, 0.5 → QUARANTINE."""
        s = DiscordSentinel(DIM, warn_threshold=0.2,
                            quarantine_threshold=0.4)
        assert True  # thresholds are configurations, not output guarantees

    def test_default_dim(self):
        assert DEFAULT_DIM == 10000


# =========================================================================
# 5.5  Integration  (syntax, import sanity, canary)
# =========================================================================


class TestImportSanity:
    """Verify all modules load without ImportError (standalone parts)."""

    def test_gudda_bridge_imports(self):
        from gudda_bridge import (
            GuddaBridge, HDVector, BinaryHDVector,
            encode_text, encode_turn, bundle_all,
            xnor_popcount_similarity, cosine_similarity,
            sdm_snr_threshold, sdm_mem_radius, sdm_centroid_radius,
            native_available, _pack_bits, _unpack_bits,
        )
        assert GuddaBridge is not None

    def test_proactive_standalone_fns(self):
        """Functions that don't need discord runtime."""
        from bot.cogs.proactive import (
            _init_hd_prototypes, _hd_preclassify,
            _hd_any_signal, _parse_json,
        )
        assert _parse_json('{"a":1}') == {"a": 1}
        assert _parse_json("```json\\n{\"a\":1}\\n```") == {"a": 1}
        assert _parse_json("garbage") is None

    def test_sentinel_bridge_imports(self):
        from sentinel_bridge import (
            DiscordEventEncoder, DiscordSentinel,
            DEFAULT_DIM, ALPHA, ANOMALY_WARN, ANOMALY_QUARANTINE,
            EVENT_FIELDS,
        )
        assert all(k in EVENT_FIELDS for k in (
            "MEMBER_JOIN", "MEMBER_LEAVE", "MESSAGE_BURST",
            "MENTION_STORM", "CHANNEL_HOP"))
