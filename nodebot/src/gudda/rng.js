// Deterministic randomness, bit-compatible with CPython's `random.Random`.
//
// The HD engine's whole contract is that a given string always produces the
// same hypervector. gudda_bridge.py gets that from `random.Random(seed)`, so
// this is MT19937 plus CPython's `init_by_array` seeding — which lets the port
// be checked against the Python original vector-for-vector rather than merely
// "looks statistically similar". test/gudda.test.js pins that parity.
//
// One shortcut worth knowing. Every draw in the Python is `rng.random() < 0.5`,
// and CPython's `random()` is genrand_res53: two 32-bit draws combined into a
// 53-bit double, `(a >> 5) * 2**26 + (b >> 6)` over 2**53. That is < 0.5
// exactly when the top bit of the first draw is 0 — the second draw only moves
// the low bits and can never carry. So `nextBit()` reads bit 31 of draw one,
// discards draw two, and never touches floating point. Same bits, no doubles.

const N = 624;
const M = 397;
const MATRIX_A = 0x9908b0df;
const UPPER_MASK = 0x80000000;
const LOWER_MASK = 0x7fffffff;

export class MT19937 {
  constructor(seed) {
    this.mt = new Uint32Array(N);
    this.mti = N + 1;
    if (seed !== undefined) this.initByArray(seedToKey(seed));
  }

  initGenrand(s) {
    const mt = this.mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < N; i += 1) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      // 1812433253 * prev, kept exact in 32 bits by splitting the multiply —
      // Math.imul would be fine too, but the split mirrors the C reference.
      const hi = ((prev >>> 16) * 1812433253) >>> 0;
      const lo = ((prev & 0xffff) * 1812433253) >>> 0;
      mt[i] = (((hi << 16) >>> 0) + lo + i) >>> 0;
    }
    this.mti = N;
  }

  initByArray(key) {
    this.initGenrand(19650218);
    const mt = this.mt;
    let i = 1;
    let j = 0;
    let k = Math.max(N, key.length);
    for (; k; k -= 1) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      const hi = ((prev >>> 16) * 1664525) >>> 0;
      const lo = ((prev & 0xffff) * 1664525) >>> 0;
      const mult = (((hi << 16) >>> 0) + lo) >>> 0;
      mt[i] = ((((mt[i] ^ mult) >>> 0) + key[j] + j) >>> 0);
      i += 1;
      j += 1;
      if (i >= N) { mt[0] = mt[N - 1]; i = 1; }
      if (j >= key.length) j = 0;
    }
    for (k = N - 1; k; k -= 1) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      const hi = ((prev >>> 16) * 1566083941) >>> 0;
      const lo = ((prev & 0xffff) * 1566083941) >>> 0;
      const mult = (((hi << 16) >>> 0) + lo) >>> 0;
      mt[i] = ((((mt[i] ^ mult) >>> 0) - i) >>> 0);
      i += 1;
      if (i >= N) { mt[0] = mt[N - 1]; i = 1; }
    }
    mt[0] = 0x80000000;
  }

  /** One 32-bit draw — the C reference's genrand_int32. */
  next() {
    const mt = this.mt;
    if (this.mti >= N) {
      let kk = 0;
      for (; kk < N - M; kk += 1) {
        const y = ((mt[kk] & UPPER_MASK) | (mt[kk + 1] & LOWER_MASK)) >>> 0;
        mt[kk] = (mt[kk + M] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0)) >>> 0;
      }
      for (; kk < N - 1; kk += 1) {
        const y = ((mt[kk] & UPPER_MASK) | (mt[kk + 1] & LOWER_MASK)) >>> 0;
        mt[kk] = (mt[kk + (M - N)] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0)) >>> 0;
      }
      const y = ((mt[N - 1] & UPPER_MASK) | (mt[0] & LOWER_MASK)) >>> 0;
      mt[N - 1] = (mt[M - 1] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0)) >>> 0;
      this.mti = 0;
    }
    let y = mt[this.mti];
    this.mti += 1;
    y = (y ^ (y >>> 11)) >>> 0;
    y = (y ^ ((y << 7) & 0x9d2c5680)) >>> 0;
    y = (y ^ ((y << 15) & 0xefc60000)) >>> 0;
    y = (y ^ (y >>> 18)) >>> 0;
    return y >>> 0;
  }

  /** CPython's random.random() — genrand_res53. */
  random() {
    const a = this.next() >>> 5;
    const b = this.next() >>> 6;
    return (a * 67108864 + b) * (1.0 / 9007199254740992.0);
  }

  /** `random() < 0.5` without the double. Consumes the same two draws. */
  nextBit() {
    const first = this.next();
    this.next();
    return (first & UPPER_MASK) === 0 ? 1 : 0;
  }
}

/** CPython seeds from abs(n) split into 32-bit little-endian words. */
function seedToKey(seed) {
  let n = typeof seed === 'bigint' ? seed : BigInt(seed);
  if (n < 0n) n = -n;
  if (n === 0n) return [0];
  const key = [];
  while (n > 0n) {
    key.push(Number(n & 0xffffffffn));
    n >>= 32n;
  }
  return key;
}

const MASK64 = 0xffffffffffffffffn;
const HASH_INIT = 0x3141592653589793n;
const HASH_MULT = 0x517cc1b727220a95n;

/**
 * gudda_bridge._stable_hash — a 64-bit rotate/xor/multiply over UTF-8 bytes.
 *
 * The Python leaves `h << 5` unmasked before the multiply, but bits at or above
 * 64 can only land at or above bit 64 of the product, which the mask drops. So
 * masking early here is exact, not an approximation.
 */
export function stableHash(str) {
  let h = HASH_INIT;
  for (const byte of Buffer.from(str, 'utf8')) {
    h = ((((h << 5n) | (h >> 59n)) & MASK64) ^ BigInt(byte)) & MASK64;
    h = (h * HASH_MULT) & MASK64;
  }
  return h;
}

/** An MT19937 seeded the way `random.Random(_stable_hash(key))` would be. */
export function rngForKey(key) {
  return new MT19937(stableHash(key));
}
