// Thin wrapper over db.js's companion_threads table — the small list of
// active shared threads (a coding project being discussed, a music idea, an
// unanswered question, something promised) that intent.js and the context
// packet's OPEN line draw from. Kept small on purpose: archiveStale() below
// is what keeps the list from growing without bound.
import * as db from '../db.js';

export function addThread(guildId, userId, { title, summary = null, importance = 0.5 }) {
  return db.addCompanionThread(guildId, userId, { title, summary, importance });
}

/** Open threads, most important first. */
export function openThreads(guildId, userId, limit = 8) {
  return db.listCompanionThreads(guildId, userId, { status: 'open', limit });
}

export function touchThread(id, patch) {
  db.touchCompanionThread(id, patch);
}

export function resolveThread(id) {
  db.resolveCompanionThread(id);
}

export function archiveThread(id) {
  db.archiveCompanionThread(id);
}

const ARCHIVE_AFTER_DAYS = 30;
const ARCHIVE_IMPORTANCE_CEILING = 0.4;

/** Archive open threads that have gone stale and were never that important —
 *  keeps the OPEN context line short without deleting the record outright
 *  (archived threads are just excluded from openThreads()). */
export function archiveStale(guildId, userId, nowSec = Math.floor(Date.now() / 1000)) {
  const cutoff = nowSec - ARCHIVE_AFTER_DAYS * 86400;
  for (const t of openThreads(guildId, userId, 50)) {
    if (t.last_referenced_at < cutoff && t.importance <= ARCHIVE_IMPORTANCE_CEILING) archiveThread(t.id);
  }
}
