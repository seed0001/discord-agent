"""
gudda_bridge.py — GuddaLM Python Bridge & Vector Encoding Engine

Two-tier loader:
  1. Attempt native PyO3 import from GuddaLM's compiled _native.pyd.
  2. Fall back to pure-Python HDVector (MAP ±1) + BinaryHDVector (BSC 0/1, bit-packed).

Provides chat-oriented encoding primitives: n-gram text → hypervector,
role-filler turn encoding, and similarity helpers (cosine, XNOR-popcount).
"""

from __future__ import annotations

import math
import random
import struct
import sys
from typing import Optional

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
NATIVE_MODULE_PATH = r"C:\Users\zoddj\GuddaLM\python\guddalm"
NATIVE_MODULE_NAME = "_native"

# ---------------------------------------------------------------------------
# Native loader
# ---------------------------------------------------------------------------
_native = None  # cached native module handle


def _load_native():
    """Try importing the compiled PyO3 native module.  Returns the module or None."""
    global _native
    if _native is not None:
        return _native
    try:
        import importlib
        import importlib.util
        import importlib.machinery
        import os

        spec = importlib.machinery.PathFinder.find_spec(
            NATIVE_MODULE_NAME, [NATIVE_MODULE_PATH]
        )
        if spec is not None:
            _native = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(_native)
            return _native
    except Exception:
        pass
    _native = False  # sentinel: don't retry
    return None


def native_available() -> bool:
    """True if the compiled PyO3 module loaded successfully."""
    return _load_native() is not None and _load_native() is not False


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
DEFAULT_DIM = 10000


# ===================================================================
# Pure-Python HDVector  (MAP bipolar ±1)
# ===================================================================
class HDVector:
    """MAP-architecture hyperdimensional vector  (bipolar ±1 elements).

    Operations: bind (element-wise multiply), bundle (add), permute (cyclic
    shift), cosine similarity, binarize, and deterministic ``from_key()``.
    """

    __slots__ = ("dim", "data")

    def __init__(self, dim: int = DEFAULT_DIM, data: Optional[list[float]] = None):
        self.dim = dim
        if data is not None:
            if len(data) != dim:
                raise ValueError(f"data length {len(data)} != dim {dim}")
            self.data = list(data)
        else:
            self.data = [1.0 if random.random() < 0.5 else -1.0 for _ in range(dim)]

    # -- factories -----------------------------------------------------------

    @classmethod
    def zeros(cls, dim: int = DEFAULT_DIM) -> "HDVector":
        return cls(dim, [0.0] * dim)

    @classmethod
    def ones(cls, dim: int = DEFAULT_DIM) -> "HDVector":
        return cls(dim, [1.0] * dim)

    @classmethod
    def from_key(cls, key: str, dim: int = DEFAULT_DIM) -> "HDVector":
        """Deterministic bipolar vector from a string seed."""
        h = _stable_hash(key)
        rng = random.Random(h)
        return cls(dim, [1.0 if rng.random() < 0.5 else -1.0 for _ in range(dim)])

    # -- VSA operations -----------------------------------------------------

    def bind(self, other: "HDVector") -> "HDVector":
        if self.dim != other.dim:
            raise ValueError(f"dim mismatch: {self.dim} vs {other.dim}")
        return HDVector(self.dim, [a * b for a, b in zip(self.data, other.data)])

    def bundle(self, other: "HDVector") -> "HDVector":
        if self.dim != other.dim:
            raise ValueError(f"dim mismatch: {self.dim} vs {other.dim}")
        return HDVector(self.dim, [a + b for a, b in zip(self.data, other.data)])

    def permute(self, shift: int = 1) -> "HDVector":
        shift = shift % self.dim
        return HDVector(self.dim, self.data[-shift:] + self.data[:-shift])

    def cosine_similarity(self, other: "HDVector") -> float:
        if self.dim != other.dim:
            raise ValueError(f"dim mismatch: {self.dim} vs {other.dim}")
        dot = 0.0
        n1 = 0.0
        n2 = 0.0
        for a, b in zip(self.data, other.data):
            dot += a * b
            n1 += a * a
            n2 += b * b
        denom = math.sqrt(n1 * n2)
        return 0.0 if denom == 0.0 else max(-1.0, min(1.0, dot / denom))

    def binarize(self) -> "HDVector":
        data = [
            1.0 if x > 0 else (-1.0 if x < 0 else (1.0 if random.random() < 0.5 else -1.0))
            for x in self.data
        ]
        return HDVector(self.dim, data)

    # -- convenience ---------------------------------------------------------

    def __repr__(self) -> str:
        return f"<HDVector dim={self.dim}>"

    def to_binary(self) -> "BinaryHDVector":
        """Convert MAP (±1) → BSC (0/1)."""
        bits = [1 if x > 0 else 0 for x in self.data]
        return BinaryHDVector(self.dim, bits)


# ===================================================================
# Pure-Python BinaryHDVector  (BSC 0/1, bit-packed)
# ===================================================================
class BinaryHDVector:
    """BSC-architecture hyperdimensional vector  (binary 0/1, bit-packed).

    Binding via XOR (self-inverse).  Bundling via majority rule.
    Similarity via XNOR-popcount   (~100× faster than MAP cosine).
    """

    __slots__ = ("dim", "_words")

    def __init__(
        self,
        dim: int = DEFAULT_DIM,
        bits: Optional[list[int]] = None,
        words: Optional[list[int]] = None,
    ):
        self.dim = dim
        word_count = (dim + 63) // 64
        if words is not None:
            if len(words) != word_count:
                raise ValueError(f"words len {len(words)} != {word_count}")
            self._words = list(words)
        elif bits is not None:
            if len(bits) != dim:
                raise ValueError(f"bits len {len(bits)} != {dim}")
            self._words = _pack_bits(bits)
        else:
            self._words = [
                random.getrandbits(64) for _ in range(word_count)
            ]
            # zero out padding bits beyond dim
            if dim % 64:
                self._words[-1] &= (1 << dim) - 1

    # -- factories -----------------------------------------------------------

    @classmethod
    def zeros(cls, dim: int = DEFAULT_DIM) -> "BinaryHDVector":
        return cls(dim, [0] * dim)

    @classmethod
    def from_key(cls, key: str, dim: int = DEFAULT_DIM) -> "BinaryHDVector":
        h = _stable_hash(key)
        rng = random.Random(h)
        bits = [1 if rng.random() < 0.5 else 0 for _ in range(dim)]
        return cls(dim, bits)

    # -- VSA operations -----------------------------------------------------

    def bind(self, other: "BinaryHDVector") -> "BinaryHDVector":
        if self.dim != other.dim:
            raise ValueError(f"dim mismatch: {self.dim} vs {other.dim}")
        return BinaryHDVector(
            self.dim,
            words=[a ^ b for a, b in zip(self._words, other._words)],
        )

    def bundle(self, other: "BinaryHDVector") -> "BinaryHDVector":
        """Majority-rule bundling  (bitwise majority of two vectors)."""
        if self.dim != other.dim:
            raise ValueError(f"dim mismatch: {self.dim} vs {other.dim}")
        # For two vectors, majority is just bitwise AND (1+1=2≥2),
        # but XOR encodes disagreement.  Use the standard BSC rule:
        # bundle = (a & b) | (~a & b) = b for two vectors?  No —
        # correct majority for two is (a & b) | (a & ~b) | (~a & b) = a|b.
        # Wait: majority(0,0)=0, (0,1)=0, (1,0)=0, (1,1)=1 actually means
        # majority threshold ≥2 → need sum popcounts → AND sums to 2+
        # For two vectors: majority(i) = a[i] AND b[i]   (since 1+1=2≥2,
        # but 1+0=0+1=0+0=0<2).  So majority = self & other (bitwise AND).
        # However, "majority rule" for binary spatter codes commonly uses
        # the sum → threshold approach.  For two vectors this is AND.
        # For correctness with >2 vectors, use bundle_all.
        return BinaryHDVector(
            self.dim,
            words=[a & b for a, b in zip(self._words, other._words)],
        )

    def permute(self, shift: int = 1) -> "BinaryHDVector":
        """Cyclic bit rotation over the full bit vector."""
        shift = shift % self.dim
        if shift == 0:
            return BinaryHDVector(self.dim, words=list(self._words))
        words = list(self._words)
        n_words = len(words)
        # Rotate across word boundaries via carry chain
        for _ in range(shift):
            carry = 0
            for i in range(n_words):
                new_carry = (words[i] >> 63) & 1
                words[i] = ((words[i] << 1) | carry) & ((1 << 64) - 1)
                carry = new_carry
        if self.dim % 64:
            words[-1] &= (1 << self.dim) - 1
        return BinaryHDVector(self.dim, words=words)

    def xnor_popcount_similarity(self, other: "BinaryHDVector") -> float:
        """XNOR-popcount similarity ∈ [0, 1].

        Each word carries 64 bits, but the *last* word may have <64 valid
        bits when dim is not a multiple of 64.  We mask out padding bits so
        the similarity is always dimension-correct.
        """
        if self.dim != other.dim:
            raise ValueError(f"dim mismatch: {self.dim} vs {other.dim}")
        total = 0
        n_words = len(self._words)
        for i, (a, b) in enumerate(zip(self._words, other._words)):
            # Only the last word may have padded bits; mask them out
            if i == n_words - 1:
                valid = self.dim % 64
                if valid:
                    mask = (1 << valid) - 1
                    total += _popcount(~(a ^ b) & mask)
                    continue
            total += _popcount(~(a ^ b) & ((1 << 64) - 1))
        return total / self.dim

    def cosine_similarity(self, other: "BinaryHDVector") -> float:
        """Cosine similarity in bipolar space  ≠ [-1, 1].

        Maps 0→-1, 1→+1, then computes cosine.  Slower than XNOR-popcount
        but useful for cross-check.
        """
        dot = 0
        n1 = 0
        n2 = 0
        for a, b in zip(self._words, other._words):
            # unpack 0/1 → ±1 per bit
            w = a ^ b  # 1 where bits differ → -1 * -1 product = -1(?)
            # Actually:  map: 0→-1, 1→+1;  product = (+1)*(+1)=+1
            # if bits equal, else (-1)*(+1) = -1.
            # XNOR bit = 1 if equal, 0 if differ.  So sum over bits of
            # (2*xnor - 1) gives dot product.
            eq = ~(a ^ b) & ((1 << 64) - 1)
            dot += 2 * _popcount(eq) - 64
            n1 += _popcount(a)  # = sum of a as ±1 magnitude squared = sum of 1's = popcount
            n2 += _popcount(b)
        # In bipolar: norm^2 = dimension (since each element ±1 → squared = 1)
        norm_product = math.sqrt(n1 * n2)
        return 0.0 if norm_product == 0 else max(-1.0, min(1.0, dot / norm_product))

    def to_bits(self) -> list[int]:
        """Unpack to list of 0/1 ints."""
        return _unpack_bits(self._words, self.dim)

    def __repr__(self) -> str:
        return f"<BinaryHDVector dim={self.dim}>"


# ===================================================================
# N-gram text encoder
# ===================================================================
def encode_text(
    text: str,
    dim: int = DEFAULT_DIM,
    ngram: int = 3,
    stride: int = 1,
    char_level: bool = True,
) -> BinaryHDVector:
    """Encode text into a deterministic BinaryHDVector via n-gram permutation.

    For each n-gram window, a random bipolar base vector is generated from
    the n-gram hash, then permuted by position.  All resulting vectors are
    bundled via majority rule.

    Args:
        text: Input string.
        dim: HD vector dimensionality.
        ngram: N-gram size (3 = trigram).
        stride: Slide window by this many characters.
        char_level: True→character n-grams, False→word n-grams.

    Returns:
        BinaryHDVector fingerprint of the text.
    """
    if not text:
        return BinaryHDVector.zeros(dim)

    if not char_level:
        tokens = text.split()
    else:
        tokens = text

    ngrams = []
    for i in range(0, max(len(tokens) - ngram + 1, 1), stride):
        window = tokens[i : i + ngram]
        if not char_level:
            gram = " ".join(window)
        else:
            gram = "".join(window)
        h = _stable_hash(gram)
        rng = random.Random(h)
        bits = [1 if rng.random() < 0.5 else 0 for _ in range(dim)]
        vec = BinaryHDVector(dim, bits).permute(i)
        ngrams.append(vec)

    if not ngrams:
        h = _stable_hash(text)
        rng = random.Random(h)
        bits = [1 if rng.random() < 0.5 else 0 for _ in range(dim)]
        return BinaryHDVector(dim, bits)

    return bundle_all(*ngrams, dim=dim)


# ===================================================================
# Role-filler binding  (for turn/event encoding)
# ===================================================================
def encode_turn(
    speaker: str,
    text: str,
    timestamp: float,
    source: str,
    dim: int = DEFAULT_DIM,
) -> BinaryHDVector:
    """Encode a conversation turn as a role-filler HD vector.

    Composition::

        turn = bin("speaker") ⊛ bin(speaker)
             ⊕ bin("text")    ⊛ encode_text(text)
             ⊕ bin("time")    ⊛ bin(str(timestamp))
             ⊕ bin("source")  ⊛ bin(source)

    where bin(key) = deterministic BinaryHDVector::from_key(key).

    Returns:
        A single BinaryHDVector superposing all role-filler bindings.
    """
    # Role vectors  (deterministic)
    role_speaker = BinaryHDVector.from_key("speaker", dim)
    role_text = BinaryHDVector.from_key("text", dim)
    role_time = BinaryHDVector.from_key("time", dim)
    role_source = BinaryHDVector.from_key("source", dim)

    # Filler vectors
    filler_speaker = BinaryHDVector.from_key(speaker, dim)
    # text → n-gram fingerprint
    filler_text = encode_text(text, dim)
    filler_time = BinaryHDVector.from_key(str(timestamp), dim)
    filler_source = BinaryHDVector.from_key(source, dim)

    # Bind role ⊛ filler, then bundle all
    bound = [
        role_speaker.bind(filler_speaker),
        role_text.bind(filler_text),
        role_time.bind(filler_time),
        role_source.bind(filler_source),
    ]

    return bundle_all(*bound, dim=dim)


def bundle_all(*vecs: BinaryHDVector, dim: Optional[int] = None) -> BinaryHDVector:
    """Bundle multiple BinaryHDVectors via majority rule.

    For each bit position, if the count of 1s across all vectors exceeds
    n/2 the result bit is 1; ties (equal counts) break to 0.

    Uses word-level accumulation for speed with n < ~64, falls back to
    bit-level for large n.
    """
    if not vecs:
        d = dim or DEFAULT_DIM
        return BinaryHDVector.zeros(d)

    d = vecs[0].dim
    n = len(vecs)

    # Word-level: accumulate per-word popcount per bit position.
    # For n < 64 we can unroll per bit position per word.
    word_count = (d + 63) // 64
    result_words = [0] * word_count
    threshold = n // 2  # strict majority

    for wi in range(word_count):
        # Count how many vectors have a 1 at each bit in this word
        bit_counts = [0] * 64
        for v in vecs:
            w = v._words[wi]
            for b in range(64):
                if (w >> b) & 1:
                    bit_counts[b] += 1
        # Build result word
        rw = 0
        for b in range(64):
            if bit_counts[b] > threshold:
                rw |= 1 << b
        result_words[wi] = rw

    return BinaryHDVector(d, words=result_words)


# ===================================================================
# Similarity helpers
# ===================================================================
def cosine_similarity(a: list[float], b: list[float]) -> float:
    """Cosine similarity between two float vectors  ∈ [-1, 1]."""
    if len(a) != len(b):
        raise ValueError(f"length mismatch: {len(a)} vs {len(b)}")
    dot = n1 = n2 = 0.0
    for x, y in zip(a, b):
        dot += x * y
        n1 += x * x
        n2 += y * y
    denom = math.sqrt(n1 * n2)
    return 0.0 if denom == 0.0 else max(-1.0, min(1.0, dot / denom))


def xnor_popcount_similarity(a: list[int], b: list[int]) -> float:
    """XNOR-popcount similarity between two binary (0/1) lists  ∈ [0, 1]."""
    if len(a) != len(b):
        raise ValueError(f"length mismatch: {len(a)} vs {len(b)}")
    same = sum(1 for x, y in zip(a, b) if x == y)
    return same / len(a)


# ===================================================================
# SDM threshold helpers
# ===================================================================
def sdm_snr_threshold(dim: int) -> float:
    """SNR similarity threshold: N/2 - sqrt(N/2)."""
    return dim / 2 - math.sqrt(dim / 2)


def sdm_mem_radius(dim: int) -> float:
    """Max memory capacity radius: N/2."""
    return dim / 2


def sdm_centroid_radius(dim: int) -> float:
    """Centroid bundling radius: N/2 - sqrt(N)."""
    return dim / 2 - math.sqrt(dim)


# ===================================================================
# Internal helpers
# ===================================================================


def _stable_hash(s: str) -> int:
    """Deterministic 64-bit hash from a string."""
    h = 0x3141592653589793
    for ch in s.encode("utf-8"):
        h = ((h << 5) | (h >> 59)) ^ ch
        h = (h * 0x517CC1B727220A95) & 0xFFFFFFFFFFFFFFFF
    return h


def _popcount(x: int) -> int:
    """Bit popcount for a 64-bit word."""
    return x.bit_count()


def _pack_bits(bits: list[int]) -> list[int]:
    """Pack list of 0/1 ints into u64 words."""
    words = []
    for i in range(0, len(bits), 64):
        w = 0
        for j in range(min(64, len(bits) - i)):
            if bits[i + j]:
                w |= 1 << j
        words.append(w)
    return words


def _unpack_bits(words: list[int], dim: int) -> list[int]:
    """Unpack u64 words into list of 0/1 ints."""
    bits = []
    for w in words:
        for j in range(64):
            if len(bits) >= dim:
                break
            bits.append(1 if (w >> j) & 1 else 0)
    return bits


# ===================================================================
# Convenience wrapper: GuddaBridge
# ===================================================================
class GuddaBridge:
    """Unified interface to GuddaLM HDC primitives for the discord-agent.

    Uses the native PyO3 module when available; falls back to pure-Python
    implementations otherwise.
    """

    def __init__(self, dim: int = DEFAULT_DIM):
        self.dim = dim
        self._native = _load_native()
        self._using_native = self._native is not None and self._native is not False

    @property
    def is_native(self) -> bool:
        return self._using_native

    def encode_text(self, text: str, ngram: int = 3) -> BinaryHDVector:
        return encode_text(text, self.dim, ngram=ngram)

    def encode_turn(
        self, speaker: str, text: str, timestamp: float, source: str
    ) -> BinaryHDVector:
        return encode_turn(speaker, text, timestamp, source, self.dim)

    def cosine_sim(self, a: BinaryHDVector, b: BinaryHDVector) -> float:
        return a.xnor_popcount_similarity(b)

    def bundle_all(self, *vecs: BinaryHDVector) -> BinaryHDVector:
        return bundle_all(*vecs, dim=self.dim)

    def sdm_snr(self) -> float:
        return sdm_snr_threshold(self.dim)

    def sdm_mem(self) -> float:
        return sdm_mem_radius(self.dim)

    def sdm_centroid(self) -> float:
        return sdm_centroid_radius(self.dim)

    def __repr__(self) -> str:
        mode = "native" if self._using_native else "pure-Python"
        return f"<GuddaBridge dim={self.dim} [{mode}]>"
