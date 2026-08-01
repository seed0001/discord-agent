// Hyperdimensional vector engine — the Node port of gudda_bridge.py.
//
// Two vector types, as in the original:
//
//   HDVector        MAP architecture, bipolar ±1, real-valued. Binds by
//                   element-wise product, bundles by sum. Used by the event
//                   sentinel, which needs a decaying real-valued baseline.
//   BinaryHDVector  BSC architecture, binary 0/1, bit-packed. Binds by XOR,
//                   compares by XNOR-popcount. Used for text, turns and the
//                   memory accumulators, where it is much cheaper.
//
// The port is bit-exact with the Python: same `_stable_hash`, same MT19937
// draw order (see rng.js), so a given string yields the same vector in both.
// test/gudda.test.js pins that against fixtures generated from the Python.
//
// Two deliberate deviations, both implementation-only:
//
//   * Storage is Uint32Array/Float64Array rather than Python lists of ints,
//     and `bundleAll` accumulates bit counts as it goes instead of building
//     every intermediate vector. Same output, and it makes dim=10000 usable
//     on a hot path — the Python draws ~2M floats per message encode.
//   * `fromKey` memoizes. It is a pure function of (key, dim) and the same
//     handful of role and prototype keys are hit on every single call.
//
// Two faithfully-ported quirks that are worth knowing about before you rely
// on them — see BinaryHDVector.permute and .bundle.

import { MT19937, stableHash } from './rng.js';

export const DEFAULT_DIM = 10000;

/** The native PyO3 path in gudda_bridge.py was Windows-only and never
 *  loaded on the server. This port is the pure implementation only. */
export function nativeAvailable() {
  return false;
}

// -- deterministic bit generation --------------------------------------------

const FROM_KEY_CACHE = new Map();
const FROM_KEY_CACHE_MAX = 512;

function cacheGet(cache, key, build) {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const made = build();
  // Crude FIFO eviction. The working set is role/prototype vectors plus
  // whatever n-grams the current message repeats, so it barely ever trips.
  if (cache.size >= FROM_KEY_CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, made);
  return made;
}

function wordsFromKey(key, dim) {
  const rng = new MT19937(stableHash(key));
  const words = new Uint32Array((dim + 31) >>> 5);
  for (let i = 0; i < dim; i += 1) {
    if (rng.nextBit()) words[i >>> 5] |= 1 << (i & 31);
  }
  return words;
}

function popcount32(x) {
  let v = x - ((x >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0f0f0f0f;
  return (v * 0x01010101) >>> 24;
}

// ============================================================================
// BinaryHDVector — BSC 0/1, bit-packed
// ============================================================================

export class BinaryHDVector {
  /** @param {number} dim @param {Uint32Array} [words] */
  constructor(dim = DEFAULT_DIM, words = null) {
    this.dim = dim;
    const count = (dim + 31) >>> 5;
    if (words) {
      if (words.length !== count) {
        throw new Error(`words len ${words.length} != ${count}`);
      }
      this.words = words;
    } else {
      this.words = new Uint32Array(count);
      for (let i = 0; i < dim; i += 1) {
        if (Math.random() < 0.5) this.words[i >>> 5] |= 1 << (i & 31);
      }
    }
    maskPadding(this.words, dim);
  }

  static zeros(dim = DEFAULT_DIM) {
    return new BinaryHDVector(dim, new Uint32Array((dim + 31) >>> 5));
  }

  static fromBits(bits, dim = bits.length) {
    const words = new Uint32Array((dim + 31) >>> 5);
    for (let i = 0; i < dim; i += 1) {
      if (bits[i]) words[i >>> 5] |= 1 << (i & 31);
    }
    return new BinaryHDVector(dim, words);
  }

  /** Deterministic vector for a string. Memoized; treat the result as frozen. */
  static fromKey(key, dim = DEFAULT_DIM) {
    return cacheGet(FROM_KEY_CACHE, `bsc:${dim}:${key}`, () => (
      new BinaryHDVector(dim, wordsFromKey(key, dim))
    ));
  }

  /** XOR binding — self-inverse, so bind(a, b).bind(b) === a. */
  bind(other) {
    assertDim(this, other);
    const out = new Uint32Array(this.words.length);
    for (let i = 0; i < out.length; i += 1) out[i] = this.words[i] ^ other.words[i];
    return new BinaryHDVector(this.dim, out);
  }

  /**
   * Two-vector bundle.
   *
   * This is bitwise AND, matching the Python. Majority-of-two with ties
   * breaking to 0 does reduce to AND, so it is self-consistent — but it is
   * lossy in a way majority over three-or-more is not, and the original's
   * comment block visibly argues with itself about it. Prefer `bundleAll`,
   * which is what every caller in the integration path actually uses.
   */
  bundle(other) {
    assertDim(this, other);
    const out = new Uint32Array(this.words.length);
    for (let i = 0; i < out.length; i += 1) out[i] = this.words[i] & other.words[i];
    return new BinaryHDVector(this.dim, out);
  }

  /**
   * Positional shift, used by `encodeText` to distinguish n-gram order.
   *
   * Despite the original's "cyclic bit rotation" docstring this shifts rather
   * than rotates: the Python's carry chain drops the carry off the final word
   * instead of feeding it back to bit 0, so the low `shift` bits become 0 and
   * the top `shift` bits fall off the end. Ported as-is, because changing it
   * would silently give this bot a different text encoding from the reviewed
   * Python. At dim=10000 a few hundred lost bits is under 3% of the vector
   * and bundling washes it out, which is why it was never noticed.
   */
  permute(shift = 1) {
    const s = ((shift % this.dim) + this.dim) % this.dim;
    if (s === 0) return new BinaryHDVector(this.dim, Uint32Array.from(this.words));
    const n = this.words.length;
    const out = new Uint32Array(n);
    const wordShift = s >>> 5;
    const bitShift = s & 31;
    for (let i = n - 1; i >= 0; i -= 1) {
      const src = i - wordShift;
      if (src < 0) break;
      let v = this.words[src] << bitShift;
      if (bitShift && src > 0) v |= this.words[src - 1] >>> (32 - bitShift);
      out[i] = v;
    }
    return new BinaryHDVector(this.dim, out);
  }

  /** Fraction of matching bits, in [0, 1]. Padding bits are excluded. */
  xnorPopcountSimilarity(other) {
    assertDim(this, other);
    const n = this.words.length;
    let total = 0;
    for (let i = 0; i < n; i += 1) {
      let eq = ~(this.words[i] ^ other.words[i]);
      if (i === n - 1) {
        const valid = this.dim & 31;
        if (valid) eq &= (1 << valid) - 1;
      }
      total += popcount32(eq >>> 0);
    }
    return total / this.dim;
  }

  toBits() {
    const bits = new Uint8Array(this.dim);
    for (let i = 0; i < this.dim; i += 1) {
      bits[i] = (this.words[i >>> 5] >>> (i & 31)) & 1;
    }
    return bits;
  }

  /** BSC 0/1 → MAP ±1. */
  toMap() {
    const data = new Float64Array(this.dim);
    for (let i = 0; i < this.dim; i += 1) {
      data[i] = ((this.words[i >>> 5] >>> (i & 31)) & 1) ? 1 : -1;
    }
    return new HDVector(this.dim, data);
  }
}

// ============================================================================
// HDVector — MAP ±1, real-valued
// ============================================================================

export class HDVector {
  constructor(dim = DEFAULT_DIM, data = null) {
    this.dim = dim;
    if (data) {
      if (data.length !== dim) throw new Error(`data length ${data.length} != dim ${dim}`);
      this.data = data instanceof Float64Array ? data : Float64Array.from(data);
    } else {
      this.data = new Float64Array(dim);
      for (let i = 0; i < dim; i += 1) this.data[i] = Math.random() < 0.5 ? 1 : -1;
    }
  }

  static zeros(dim = DEFAULT_DIM) {
    return new HDVector(dim, new Float64Array(dim));
  }

  static ones(dim = DEFAULT_DIM) {
    return new HDVector(dim, new Float64Array(dim).fill(1));
  }

  static fromKey(key, dim = DEFAULT_DIM) {
    return cacheGet(FROM_KEY_CACHE, `map:${dim}:${key}`, () => {
      const rng = new MT19937(stableHash(key));
      const data = new Float64Array(dim);
      for (let i = 0; i < dim; i += 1) data[i] = rng.nextBit() ? 1 : -1;
      return new HDVector(dim, data);
    });
  }

  /** Element-wise product. */
  bind(other) {
    assertDim(this, other);
    const out = new Float64Array(this.dim);
    for (let i = 0; i < this.dim; i += 1) out[i] = this.data[i] * other.data[i];
    return new HDVector(this.dim, out);
  }

  /** Element-wise sum — the accumulator operation. */
  bundle(other) {
    assertDim(this, other);
    const out = new Float64Array(this.dim);
    for (let i = 0; i < this.dim; i += 1) out[i] = this.data[i] + other.data[i];
    return new HDVector(this.dim, out);
  }

  /** Genuine cyclic rotation, unlike the binary vector's shift. */
  permute(shift = 1) {
    const s = ((shift % this.dim) + this.dim) % this.dim;
    const out = new Float64Array(this.dim);
    for (let i = 0; i < this.dim; i += 1) out[(i + s) % this.dim] = this.data[i];
    return new HDVector(this.dim, out);
  }

  cosineSimilarity(other) {
    assertDim(this, other);
    let dot = 0;
    let n1 = 0;
    let n2 = 0;
    for (let i = 0; i < this.dim; i += 1) {
      const a = this.data[i];
      const b = other.data[i];
      dot += a * b;
      n1 += a * a;
      n2 += b * b;
    }
    const denom = Math.sqrt(n1 * n2);
    return denom === 0 ? 0 : Math.max(-1, Math.min(1, dot / denom));
  }

  binarize() {
    const out = new Float64Array(this.dim);
    for (let i = 0; i < this.dim; i += 1) {
      const x = this.data[i];
      out[i] = x > 0 ? 1 : (x < 0 ? -1 : (Math.random() < 0.5 ? 1 : -1));
    }
    return new HDVector(this.dim, out);
  }

  /** MAP ±1 → BSC 0/1, sign-thresholded. */
  toBinary() {
    const words = new Uint32Array((this.dim + 31) >>> 5);
    for (let i = 0; i < this.dim; i += 1) {
      if (this.data[i] > 0) words[i >>> 5] |= 1 << (i & 31);
    }
    return new BinaryHDVector(this.dim, words);
  }
}

// ============================================================================
// Encoders
// ============================================================================

/**
 * Bundle any number of binary vectors by majority rule.
 *
 * A bit is set when strictly more than floor(n/2) of the inputs have it set,
 * so an even split breaks to 0 — same tie-break as the Python.
 */
export function bundleAll(vecs, dim = DEFAULT_DIM) {
  if (!vecs.length) return BinaryHDVector.zeros(dim);
  const d = vecs[0].dim;
  const counts = new Uint16Array(d);
  for (const v of vecs) accumulateBits(counts, v, d);
  return thresholdCounts(counts, d, vecs.length);
}

function accumulateBits(counts, vec, dim) {
  for (let i = 0; i < dim; i += 1) {
    counts[i] += (vec.words[i >>> 5] >>> (i & 31)) & 1;
  }
}

function thresholdCounts(counts, dim, n) {
  const threshold = n >>> 1;
  const words = new Uint32Array((dim + 31) >>> 5);
  for (let i = 0; i < dim; i += 1) {
    if (counts[i] > threshold) words[i >>> 5] |= 1 << (i & 31);
  }
  return new BinaryHDVector(dim, words);
}

/**
 * Encode text as a binary hypervector via position-shifted n-grams.
 *
 * Each n-gram window becomes a deterministic vector, shifted by its offset so
 * ordering carries information, and all of them are bundled by majority.
 * Counts accumulate in one pass rather than materializing every window's
 * vector, which is what makes this affordable at dim=10000.
 */
export function encodeText(text, dim = DEFAULT_DIM, { ngram = 3, stride = 1, charLevel = true } = {}) {
  if (!text) return BinaryHDVector.zeros(dim);

  // Array.from, not a plain slice: Python indexes a str by code point, so an
  // emoji outside the BMP is one token there and two UTF-16 units here. Slicing
  // the raw string would cut surrogate pairs in half and diverge on any message
  // containing one — which, this being Discord, is most of them.
  const tokens = charLevel ? Array.from(text) : text.split(/\s+/).filter(Boolean);
  const limit = Math.max(tokens.length - ngram + 1, 1);

  const counts = new Uint16Array(dim);
  let n = 0;
  for (let i = 0; i < limit; i += stride) {
    const window = tokens.slice(i, i + ngram).join(charLevel ? '' : ' ');
    const vec = BinaryHDVector.fromKey(window, dim).permute(i);
    accumulateBits(counts, vec, dim);
    n += 1;
  }

  if (!n) return BinaryHDVector.fromKey(text, dim);
  return thresholdCounts(counts, dim, n);
}

/**
 * Encode a conversation turn by role-filler binding:
 *
 *   turn = (role"speaker" ⊛ speaker) ⊕ (role"text" ⊛ encodeText(text))
 *        ⊕ (role"time" ⊛ timestamp)  ⊕ (role"source" ⊛ source)
 */
export function encodeTurn(speaker, text, timestamp, source, dim = DEFAULT_DIM) {
  const bound = [
    BinaryHDVector.fromKey('speaker', dim).bind(BinaryHDVector.fromKey(speaker, dim)),
    BinaryHDVector.fromKey('text', dim).bind(encodeText(text, dim)),
    BinaryHDVector.fromKey('time', dim).bind(BinaryHDVector.fromKey(formatTimestamp(timestamp), dim)),
    BinaryHDVector.fromKey('source', dim).bind(BinaryHDVector.fromKey(source, dim)),
  ];
  return bundleAll(bound, dim);
}

/**
 * The time filler is keyed off `str(timestamp)` in the Python, so the exact
 * text of the number is part of the vector. Python renders a whole float as
 * "1.0"; JS renders it as "1". Matching Python here keeps encodeTurn's
 * fixtures comparable across the two implementations.
 */
function formatTimestamp(ts) {
  return Number.isInteger(ts) ? `${ts}.0` : String(ts);
}

// ============================================================================
// Similarity helpers
// ============================================================================

export function cosineSimilarity(a, b) {
  if (a.length !== b.length) throw new Error(`length mismatch: ${a.length} vs ${b.length}`);
  let dot = 0;
  let n1 = 0;
  let n2 = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    n1 += a[i] * a[i];
    n2 += b[i] * b[i];
  }
  const denom = Math.sqrt(n1 * n2);
  return denom === 0 ? 0 : Math.max(-1, Math.min(1, dot / denom));
}

export function xnorPopcountSimilarity(a, b) {
  if (a.length !== b.length) throw new Error(`length mismatch: ${a.length} vs ${b.length}`);
  let same = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i] === b[i]) same += 1;
  return same / a.length;
}

// ============================================================================
// Sparse Distributed Memory radii
// ============================================================================

/** Signal-to-noise radius, N/2 − √(N/2) — the "distinguishable from noise" line. */
export function sdmSnrThreshold(dim) {
  return dim / 2 - Math.sqrt(dim / 2);
}

/** Maximum memory capacity radius, N/2. */
export function sdmMemRadius(dim) {
  return dim / 2;
}

/** Centroid bundling radius, N/2 − √N. */
export function sdmCentroidRadius(dim) {
  return dim / 2 - Math.sqrt(dim);
}

// ============================================================================
// Persistence helpers
// ============================================================================

/**
 * Pack bits to bytes, little-endian, bit i at byte i>>3 bit i&7.
 *
 * That is byte-for-byte what db.py's `struct.pack("<Q")` produced, so a blob
 * written by either implementation reads back correctly in the other.
 */
export function packBits(bits) {
  const out = Buffer.alloc(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i += 1) {
    if (bits[i]) out[i >>> 3] |= 1 << (i & 7);
  }
  return out;
}

export function unpackBits(buf, dim) {
  const bits = new Uint8Array(dim);
  for (let i = 0; i < dim; i += 1) {
    bits[i] = (buf[i >>> 3] >>> (i & 7)) & 1;
  }
  return bits;
}

// -- internals ---------------------------------------------------------------

function assertDim(a, b) {
  if (a.dim !== b.dim) throw new Error(`dim mismatch: ${a.dim} vs ${b.dim}`);
}

function maskPadding(words, dim) {
  const valid = dim & 31;
  if (valid && words.length) words[words.length - 1] &= (1 << valid) - 1;
}

/** Test seam — the memo is global and would otherwise leak between cases. */
export function _clearCaches() {
  FROM_KEY_CACHE.clear();
}
