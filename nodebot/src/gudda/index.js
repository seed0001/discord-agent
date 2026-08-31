// GuddaLM hyperdimensional layer — ported from the Python `Gudda-Ingestion`
// branch (gudda_bridge.py, sentinel_bridge.py, and the HDMemoryStore half of
// memory.py). See GUDDA_INGESTION_CHECKLIST.md for the phase breakdown.
//
// Everything here is deterministic and dependency-free: the same string always
// produces the same vector, and the encoding is bit-exact with the Python
// original (test/gudda.test.js pins it against generated fixtures).

export {
  DEFAULT_DIM,
  BinaryHDVector,
  HDVector,
  bundleAll,
  encodeText,
  encodeTurn,
  cosineSimilarity,
  xnorPopcountSimilarity,
  sdmSnrThreshold,
  sdmMemRadius,
  sdmCentroidRadius,
  packBits,
  unpackBits,
  nativeAvailable,
} from './hd.js';

export {
  DiscordSentinel,
  DiscordEventEncoder,
  EVENT_FIELDS,
  ALPHA,
  ANOMALY_WARN,
  ANOMALY_QUARANTINE,
} from './sentinel.js';

export {
  HDMemoryStore,
  HD_DIM,
  SAVE_EVERY,
  storeFor,
  dropStore,
} from './store.js';
