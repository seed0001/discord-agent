// Per-guild hypervector accumulators — the Node port of HDMemoryStore from
// memory.py.
//
// Two running accumulators per guild, both real-valued MAP sums that get
// sign-thresholded back to binary on read:
//
//   conjunctive  every turn, so it converges on whatever this server keeps
//                coming back to — the "common ground" vector.
//   disjunctive  every 5th turn, so a burst of chatter about one thing cannot
//                drown out the breadth of what else gets discussed.
//
// Plus one vector per member, superposed from their profile card, rebuilt
// whenever consolidation rewrites the card.
//
// The point of all of this is that a query costs no I/O and no model call: the
// vectors are already in memory, and comparing two of them is a popcount.

import {
  BinaryHDVector, HDVector, bundleAll, DEFAULT_DIM,
} from './hd.js';

export const HD_DIM = DEFAULT_DIM;

/** Persist to SQLite every N ingested turns. */
export const SAVE_EVERY = 25;

/** Profile card fields that get superposed into a member's vector. */
const PROFILE_FIELDS = ['goals', 'active_projects', 'constraints', 'vibe_notes'];

export class HDMemoryStore {
  constructor(guildId, dim = HD_DIM) {
    this.guildId = String(guildId);
    this.dim = dim;
    /** @type {HDVector|null} */
    this.conjunctive = null;
    /** @type {HDVector|null} */
    this.disjunctive = null;
    /** @type {Map<string, BinaryHDVector>} */
    this.profileVectors = new Map();
    this.turnCount = 0;
    this.saveCounter = 0;
  }

  // -- ingestion -------------------------------------------------------------

  /** @param {BinaryHDVector} vec a turn vector from encodeTurn() */
  ingestTurn(vec) {
    this.turnCount += 1;
    const mapVec = vec.toMap();

    this.conjunctive = this.conjunctive ? this.conjunctive.bundle(mapVec) : mapVec;

    // Sparse on purpose — see the header note about breadth vs. volume.
    if (this.turnCount % 5 === 1) {
      this.disjunctive = this.disjunctive ? this.disjunctive.bundle(mapVec) : mapVec;
    }

    this.saveCounter += 1;
  }

  get needsSave() {
    return this.saveCounter >= SAVE_EVERY;
  }

  // -- queries ---------------------------------------------------------------

  getConjunctive() {
    return this.conjunctive ? this.conjunctive.toBinary() : null;
  }

  getDisjunctive() {
    return this.disjunctive ? this.disjunctive.toBinary() : null;
  }

  getProfileVector(userId) {
    return this.profileVectors.get(String(userId)) || null;
  }

  /** Everything the caller might want, with no I/O. */
  getContext(userId = null) {
    return {
      conjunctive: this.getConjunctive(),
      disjunctive: this.getDisjunctive(),
      profile: userId === null ? null : this.getProfileVector(userId),
    };
  }

  // -- profiles --------------------------------------------------------------

  /** Superpose a member's profile card fields into one vector. An empty card
   *  drops the vector rather than leaving a stale one behind. */
  setProfileVector(userId, fields = {}) {
    const uid = String(userId);
    const vecs = PROFILE_FIELDS
      .filter((key) => fields[key])
      .map((key) => BinaryHDVector.fromKey(`${key}:${fields[key]}`, this.dim));
    if (vecs.length) this.profileVectors.set(uid, bundleAll(vecs, this.dim));
    else this.profileVectors.delete(uid);
  }

  // -- persistence -----------------------------------------------------------

  /**
   * @param {{saveHdMemory: Function}} db injected so this module stays
   *   testable without a database and free of an import cycle through db.js.
   */
  save(db) {
    const conj = this.getConjunctive();
    if (conj) db.saveHdMemory(this.guildId, 'conjunctive', conj.toBits(), this.dim);
    const disj = this.getDisjunctive();
    if (disj) db.saveHdMemory(this.guildId, 'disjunctive', disj.toBits(), this.dim);
    for (const [uid, vec] of this.profileVectors) {
      db.saveHdMemory(this.guildId, `profile:${uid}`, vec.toBits(), this.dim);
    }
    this.saveCounter = 0;
  }

  /**
   * Restore from SQLite.
   *
   * Only the binarized snapshot is stored, never the real-valued sum, so a
   * restored accumulator carries no historical weight — every past turn
   * collapses to a single ±1 vote. It is a cold start that keeps the shape of
   * what was learned, not a resumption of it, and new turns immediately begin
   * outvoting it. That is the same trade the Python made.
   */
  load(db) {
    for (const { kind, bits } of db.allHdMemory(this.guildId)) {
      const vec = BinaryHDVector.fromBits(bits, this.dim);
      if (kind === 'conjunctive') this.conjunctive = vec.toMap();
      else if (kind === 'disjunctive') this.disjunctive = vec.toMap();
      else if (kind.startsWith('profile:')) {
        this.profileVectors.set(kind.slice('profile:'.length), vec);
      }
    }
  }
}

// -- per-guild registry --------------------------------------------------------

const stores = new Map();

export function storeFor(guildId) {
  const gid = String(guildId);
  if (!stores.has(gid)) stores.set(gid, new HDMemoryStore(gid));
  return stores.get(gid);
}

export function dropStore(guildId) {
  stores.delete(String(guildId));
}

/** Test seam. */
export function _resetStores() {
  stores.clear();
}
