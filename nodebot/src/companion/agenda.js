// Thin wrapper over db.js's companion_agenda table — concrete things the
// companion actually wants to bring up, built by autonomous.js's reflection
// pass and consumed by scheduler.js/session.js so outreach is backed by real
// substance instead of just relationship-pressure numbers. Mirrors threads.js.
import * as db from '../db.js';

export function add(guildId, userId, { note, source = null }) {
  return db.addCompanionAgendaItem(guildId, userId, { note, source });
}

/** Pending agenda items, oldest first — used is not the same as resolved:
 *  once she's actually said it (DM or voice), it's consumed and should not
 *  be handed out again. */
export function pending(guildId, userId, limit = 3) {
  return db.listPendingCompanionAgenda(guildId, userId, limit);
}

export function markUsed(id) {
  db.markCompanionAgendaUsed(id);
}
