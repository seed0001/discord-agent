// Calendar / reminders / scheduled tasks.
//
// One calendar_events row (db.js) is a thing that fires into a Discord channel
// at a wall-clock time: a one-off reminder, or a recurring task (daily standup
// ping, weekly digest nudge, monthly "pay the invoice"). The model creates and
// edits them with the calendar_* tools; a background tick here posts whatever
// is due and rolls recurring rows forward to their next occurrence.
//
// Times are interpreted and displayed in the guild's `calendar_timezone`
// setting (IANA name, default "UTC"). The scheduler is deterministic and makes
// no model calls — a reminder must still fire when the AI backend is down or
// the credit balance is dry, same reasoning as the moderation path.
import { botName } from './botName.js';
import { recordTurn } from './conversation.js';
import * as db from './db.js';

const TICK_EVERY_MS = 30_000;
const MAX_HORIZON_SEC = 5 * 365 * 24 * 3600; // reject "remind me in the year 3000"
const LIST_LIMIT = 25;

export const RECURRENCES = ['once', 'hourly', 'daily', 'weekdays', 'weekly', 'monthly', 'yearly'];

let client = null;
let ticker = null;

// -- timezone helpers -------------------------------------------------------

/** Is `tz` a timezone Intl actually knows? Falls back to UTC everywhere if not. */
export function validTimezone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function guildTz(guildId) {
  const tz = db.getSetting(guildId, 'calendar_timezone');
  return validTimezone(tz) ? tz : 'UTC';
}

const WALL_FMT = new Map();
function wallFormatter(tz) {
  if (!WALL_FMT.has(tz)) {
    WALL_FMT.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    }));
  }
  return WALL_FMT.get(tz);
}

const WEEKDAY_INDEX = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/** The wall-clock components of `unixSec` as seen in `tz`. */
export function wallParts(unixSec, tz) {
  const parts = {};
  for (const p of wallFormatter(tz).formatToParts(new Date(unixSec * 1000))) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAY_INDEX[parts.weekday] ?? 0,
  };
}

/** Offset (ms) that `tz` is ahead of UTC at the instant `date`. */
function tzOffsetMs(date, tz) {
  const p = {};
  for (const part of wallFormatter(tz).formatToParts(date)) {
    if (part.type !== 'literal') p[part.type] = part.value;
  }
  const asUtc = Date.UTC(
    Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(p.hour) % 24, Number(p.minute), Number(p.second),
  );
  return asUtc - date.getTime();
}

/** A naive wall-clock time (no zone) read as local time in `tz` -> unix sec. */
export function zonedNaiveToUnix({
  year, month, day, hour = 0, minute = 0, second = 0,
}, tz) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  let offset = tzOffsetMs(new Date(guess), tz);
  let ts = guess - offset;
  // One correction pass catches DST boundaries (the offset at `ts` can differ
  // from the offset at the initial guess).
  const offset2 = tzOffsetMs(new Date(ts), tz);
  if (offset2 !== offset) {
    offset = offset2;
    ts = guess - offset;
  }
  return Math.floor(ts / 1000);
}

const DAYS_IN_MONTH = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * The next time a recurring event should fire after `unixSec`, in `tz`.
 * Returns null for 'once'. Recurrences other than 'hourly' keep the same
 * wall-clock time of day across the step, so "daily at 09:00" stays 09:00
 * through a DST change rather than drifting to 08:00 or 10:00.
 */
export function nextOccurrence(unixSec, recurrence, tz) {
  if (recurrence === 'once') return null;
  if (recurrence === 'hourly') return unixSec + 3600;

  const w = wallParts(unixSec, tz);
  let { year, month, day } = w;

  const stepDays = (n) => {
    const d = new Date(Date.UTC(year, month - 1, day));
    d.setUTCDate(d.getUTCDate() + n);
    year = d.getUTCFullYear();
    month = d.getUTCMonth() + 1;
    day = d.getUTCDate();
  };

  if (recurrence === 'daily') {
    stepDays(1);
  } else if (recurrence === 'weekly') {
    stepDays(7);
  } else if (recurrence === 'weekdays') {
    stepDays(1);
    let guard = 0;
    while (guard < 7) {
      const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
      if (dow !== 0 && dow !== 6) break;
      stepDays(1);
      guard += 1;
    }
  } else if (recurrence === 'monthly') {
    month += 1;
    if (month > 12) { month = 1; year += 1; }
    day = Math.min(day, DAYS_IN_MONTH(year, month));
  } else if (recurrence === 'yearly') {
    year += 1;
    day = Math.min(day, DAYS_IN_MONTH(year, month));
  } else {
    return null;
  }

  return zonedNaiveToUnix({
    year, month, day, hour: w.hour, minute: w.minute, second: w.second,
  }, tz);
}

// -- "when" parsing -------------------------------------------------------

const RELATIVE_RE = /^\+?\s*(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks)$/i;
const ISO_ZONED_RE = /(?:Z|[+-]\d{2}:?\d{2})$/;
const ISO_NAIVE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

const UNIT_SECONDS = {
  m: 60, min: 60, mins: 60, minute: 60, minutes: 60,
  h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600,
  d: 86400, day: 86400, days: 86400,
  w: 604800, wk: 604800, wks: 604800, week: 604800, weeks: 604800,
};

export class CalendarError extends Error {}

/**
 * Resolve a `when` string to unix seconds, interpreting bare dates/times as
 * local time in `tz`. Accepts:
 *   "+30m" / "2 hours" / "1d"        relative to now
 *   "2026-08-28 15:00"               local wall-clock in the guild tz
 *   "2026-08-28"                     that date at 09:00 local
 *   "2026-08-28T15:00:00-05:00"      explicit offset, used as-is
 */
export function parseWhen(input, tz, nowMs = Date.now()) {
  const raw = String(input || '').trim();
  if (!raw) throw new CalendarError('no time given — say when it should happen.');

  const rel = raw.match(RELATIVE_RE);
  if (rel) {
    const secs = Number(rel[1]) * UNIT_SECONDS[rel[2].toLowerCase()];
    return Math.floor(nowMs / 1000 + secs);
  }

  if (ISO_ZONED_RE.test(raw)) {
    const ms = Date.parse(raw);
    if (Number.isNaN(ms)) throw new CalendarError(`couldn't read the time "${raw}".`);
    return Math.floor(ms / 1000);
  }

  const iso = raw.match(ISO_NAIVE_RE);
  if (iso) {
    const hasTime = iso[4] !== undefined;
    return zonedNaiveToUnix({
      year: Number(iso[1]),
      month: Number(iso[2]),
      day: Number(iso[3]),
      hour: hasTime ? Number(iso[4]) : 9,
      minute: hasTime ? Number(iso[5]) : 0,
      second: iso[6] !== undefined ? Number(iso[6]) : 0,
    }, tz);
  }

  // Last resort: let the engine try. Anything it parses is treated as UTC
  // unless it carried its own offset (handled above).
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    throw new CalendarError(
      `couldn't read the time "${raw}". Use "+30m", "2h", "1d", or a date like `
      + '"2026-08-28 15:00".',
    );
  }
  return Math.floor(ms / 1000);
}

// -- formatting ----------------------------------------------------------

/** "Fri, Aug 28 2026, 3:00 PM CDT" — for tool replies the model reads back. */
export function formatLocal(unixSec, tz) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(unixSec * 1000));
}

function describeEvent(ev, tz) {
  const when = `${formatLocal(ev.next_fire, tz)} (<t:${ev.next_fire}:R>)`;
  const rec = ev.recurrence === 'once' ? '' : `, repeats ${ev.recurrence}`;
  const to = ev.mention ? ` — pings ${ev.mention}` : '';
  const details = ev.details ? ` — ${ev.details}` : '';
  return `#${ev.id}: ${ev.title}${details}\n    ${when}${rec}${to} in <#${ev.channel_id}>`;
}

// -- mentions ----------------------------------------------------------

/** Turn a `notify` argument into a stored mention string + a send() allowedMentions.
 *  `me` is available to anyone; role / @everyone / @here pings are owner-only. */
function resolveNotify(notify, { guild, userId, owner }) {
  const value = String(notify || '').trim();
  if (!value) return { mention: null, allowedMentions: { parse: [] } };

  const low = value.toLowerCase();
  if (low === 'me' || low === 'self') {
    return { mention: `<@${userId}>`, allowedMentions: { users: [String(userId)] } };
  }
  if (!owner) {
    throw new CalendarError('only the owner can set a reminder to ping other people, a role, or @everyone.');
  }
  if (low === 'everyone' || low === '@everyone' || low === 'here' || low === '@here') {
    return { mention: low.includes('here') ? '@here' : '@everyone', allowedMentions: { parse: ['everyone'] } };
  }

  const roleId = value.replace(/^<@&/, '').replace(/>$/, '');
  const role = /^\d+$/.test(roleId)
    ? guild.roles.cache.get(roleId)
    : guild.roles.cache.find((r) => r.name.toLowerCase() === low);
  if (role) return { mention: `<@&${role.id}>`, allowedMentions: { roles: [role.id] } };

  const uid = value.replace(/^<@!?/, '').replace(/>$/, '');
  if (/^\d+$/.test(uid)) return { mention: `<@${uid}>`, allowedMentions: { users: [uid] } };

  throw new CalendarError(`couldn't find a role or member matching "${value}".`);
}

/** Rebuild allowedMentions from a stored mention string, for the tick. */
function allowedMentionsFor(mention) {
  if (!mention) return { parse: [] };
  if (mention === '@everyone' || mention === '@here') return { parse: ['everyone'] };
  const role = mention.match(/^<@&(\d+)>$/);
  if (role) return { roles: [role[1]] };
  const user = mention.match(/^<@!?(\d+)>$/);
  if (user) return { users: [user[1]] };
  return { parse: [] };
}

// -- tools ---------------------------------------------------------------

export const CALENDAR_TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'calendar_add',
      description: (
        'Schedule a reminder or a recurring task. At the scheduled time the bot '
        + 'posts the title (and details) into a channel. Use this whenever '
        + 'someone asks to be reminded of something, wants a scheduled '
        + 'announcement, or wants a recurring nudge (standup, weekly digest, '
        + 'rent, etc.). Times are read in this server\'s timezone.'
      ),
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short summary of what the reminder is' },
          when: {
            type: 'string',
            description: 'When it should first fire: a relative offset like "+30m", '
              + '"2h", "1d", or a local date/time like "2026-08-28 15:00" or "2026-08-28". '
              + 'For a recurring event, give the first occurrence.',
          },
          details: { type: 'string', description: 'Optional longer text posted with the reminder' },
          recurrence: {
            type: 'string',
            enum: RECURRENCES,
            description: 'How often it repeats (default "once"). "weekdays" = Mon–Fri.',
          },
          notify: {
            type: 'string',
            description: 'Who to ping: "me" for the requester, or (owner only) a role name, '
              + 'a @mention, "everyone", or "here". Omit for no ping.',
          },
          channel: {
            type: 'string',
            description: 'Channel name/mention/ID to post in. Defaults to the current channel; '
              + 'posting elsewhere is owner-only.',
          },
        },
        required: ['title', 'when'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calendar_list',
      description: 'List this server\'s upcoming reminders and scheduled tasks, with their IDs.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calendar_update',
      description: 'Change an existing reminder by ID — its time, title, details, or recurrence. '
        + 'Only the person who created it or the owner can.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'The reminder ID (from calendar_list)' },
          when: { type: 'string', description: 'New time, same formats as calendar_add' },
          title: { type: 'string', description: 'New title' },
          details: { type: 'string', description: 'New details' },
          recurrence: { type: 'string', enum: RECURRENCES, description: 'New recurrence' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calendar_cancel',
      description: 'Cancel/delete a reminder by ID. Only the creator or the owner can.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'integer', description: 'The reminder ID (from calendar_list)' } },
        required: ['id'],
      },
    },
  },
];

export const CALENDAR_TOOL_NAMES = new Set(CALENDAR_TOOL_SCHEMAS.map((t) => t.function.name));

export function isCalendarTool(name) {
  return CALENDAR_TOOL_NAMES.has(name);
}

function resolveChannel(guild, ref) {
  const value = String(ref).trim();
  const id = value.replace(/^<#/, '').replace(/>$/, '');
  if (/^\d+$/.test(id)) {
    const c = guild.channels.cache.get(id);
    if (c) return c;
  }
  const low = value.replace(/^#/, '').toLowerCase();
  const found = guild.channels.cache.find((c) => c.name?.toLowerCase() === low);
  if (found) return found;
  throw new CalendarError(`no channel matching "${ref}".`);
}

/**
 * Run one calendar tool. `message` only needs .guild / .channel / .author —
 * a real discord.js Message from text chat, or voice.js's stand-in. `owner`
 * is whether the caller is the bot owner. Never throws.
 */
export async function execute(message, name, args = {}, owner = false) {
  try {
    const guild = message.guild;
    const guildId = guild.id;
    const userId = String(message.author.id);
    const tz = guildTz(guildId);

    if (name === 'calendar_list') {
      const rows = db.calendarList(guildId, LIST_LIMIT);
      if (!rows.length) return 'Nothing scheduled.';
      return `Upcoming (times in ${tz}):\n${rows.map((r) => describeEvent(r, tz)).join('\n')}`;
    }

    if (name === 'calendar_add') {
      const title = String(args.title || '').trim();
      if (!title) throw new CalendarError('the reminder needs a title.');
      const recurrence = args.recurrence ? String(args.recurrence).toLowerCase() : 'once';
      if (!RECURRENCES.includes(recurrence)) {
        throw new CalendarError(`recurrence must be one of: ${RECURRENCES.join(', ')}.`);
      }

      const when = parseWhen(args.when, tz);
      const nowSec = Math.floor(Date.now() / 1000);
      if (recurrence === 'once' && when <= nowSec) {
        throw new CalendarError('that time is in the past.');
      }
      if (when - nowSec > MAX_HORIZON_SEC) {
        throw new CalendarError('that is too far in the future.');
      }

      let channel = message.channel;
      if (args.channel) {
        channel = resolveChannel(guild, args.channel);
        if (channel.id !== message.channel?.id && !owner) {
          throw new CalendarError('only the owner can schedule a reminder for another channel.');
        }
      }
      if (!channel || typeof channel.isTextBased !== 'function' || !channel.isTextBased()) {
        throw new CalendarError('that channel can\'t receive messages.');
      }

      const { mention } = resolveNotify(args.notify, { guild, userId, owner });

      // A recurring event whose first occurrence is already past: roll it
      // forward so it fires next cycle rather than immediately on the tick.
      let firstFire = when;
      while (firstFire <= nowSec) {
        const rolled = nextOccurrence(firstFire, recurrence, tz);
        if (!rolled) break;
        firstFire = rolled;
      }

      const id = db.calendarAdd(guildId, {
        title,
        details: args.details ? String(args.details).slice(0, 1500) : null,
        nextFire: firstFire,
        recurrence,
        channelId: channel.id,
        mention,
        createdBy: userId,
      });
      const rec = recurrence === 'once' ? '' : `, repeating ${recurrence}`;
      return `Scheduled #${id}: "${title}" for ${formatLocal(firstFire, tz)} `
        + `(<t:${firstFire}:R>)${rec} in #${channel.name}.`;
    }

    if (name === 'calendar_update' || name === 'calendar_cancel') {
      const id = Number(args.id);
      if (!Number.isInteger(id)) throw new CalendarError('which reminder ID?');
      const ev = db.calendarGet(guildId, id);
      if (!ev || !ev.active) throw new CalendarError(`no active reminder #${id}.`);
      if (ev.created_by !== userId && !owner) {
        throw new CalendarError(`reminder #${id} was set by someone else — only they or the owner can change it.`);
      }

      if (name === 'calendar_cancel') {
        db.calendarDelete(guildId, id);
        return `Cancelled reminder #${id} ("${ev.title}").`;
      }

      const fields = {};
      if (args.title !== undefined) fields.title = String(args.title).slice(0, 300);
      if (args.details !== undefined) fields.details = String(args.details).slice(0, 1500);
      if (args.recurrence !== undefined) {
        const rec = String(args.recurrence).toLowerCase();
        if (!RECURRENCES.includes(rec)) {
          throw new CalendarError(`recurrence must be one of: ${RECURRENCES.join(', ')}.`);
        }
        fields.recurrence = rec;
      }
      if (args.when !== undefined) {
        const when = parseWhen(args.when, tz);
        const rec = fields.recurrence || ev.recurrence;
        if (rec === 'once' && when <= Math.floor(Date.now() / 1000)) {
          throw new CalendarError('that time is in the past.');
        }
        fields.next_fire = when;
      }
      if (!Object.keys(fields).length) throw new CalendarError('nothing to change.');
      db.calendarUpdate(guildId, id, fields);
      const updated = db.calendarGet(guildId, id);
      return `Updated reminder #${id}:\n${describeEvent(updated, tz)}`;
    }

    return `Unknown calendar tool: ${name}`;
  } catch (err) {
    if (err instanceof CalendarError) return `Error: ${err.message}`;
    console.warn(`[calendar] ${name} failed:`, err?.message || err);
    return `Error: couldn't run ${name} (${err?.message || err}).`;
  }
}

// -- scheduler ---------------------------------------------------------------

/** Post one due event and return its next fire time (null if it's done). */
async function fireEvent(ev) {
  const guild = client.guilds.cache.get(ev.guild_id);
  if (!guild) {
    // Bot is no longer in that guild — nothing will ever deliver this.
    db.calendarDeactivate(ev.id);
    return;
  }
  const tz = guildTz(ev.guild_id);
  const channel = guild.channels.cache.get(ev.channel_id);
  const nowSec = Math.floor(Date.now() / 1000);

  if (channel && typeof channel.isTextBased === 'function' && channel.isTextBased()) {
    const body = `${ev.mention ? `${ev.mention} ` : ''}⏰ **${ev.title}**`
      + (ev.details ? `\n${ev.details}` : '');
    try {
      await channel.send({
        content: body.slice(0, 2000),
        allowedMentions: allowedMentionsFor(ev.mention),
      });
      // In-process conversation buffer only — so the bot knows in a live chat
      // that it just fired a reminder. Deliberately NOT written to durable
      // memory: that would trigger a paid consolidation call for every tick,
      // and a reminder firing must stay free and reliable.
      recordTurn(ev.guild_id, {
        source: 'text', channel: channel.name, speaker: botName(client, ev.guild_id),
        text: `(reminder fired) ${ev.title}`,
      });
    } catch (err) {
      console.warn(`[calendar] couldn't post reminder #${ev.id}:`, err?.message || err);
    }
  } else {
    console.warn(`[calendar] reminder #${ev.id}: channel ${ev.channel_id} is gone or not text`);
  }

  // Roll forward past every occurrence we may have slept through, so a
  // redeploy that straddled several daily fires produces one catch-up post,
  // not a burst.
  let next = nextOccurrence(ev.next_fire, ev.recurrence, tz);
  if (next === null) {
    db.calendarDeactivate(ev.id, nowSec);
    return;
  }
  let guard = 0;
  while (next <= nowSec && guard < 1000) {
    const rolled = nextOccurrence(next, ev.recurrence, tz);
    if (rolled === null || rolled === next) break;
    next = rolled;
    guard += 1;
  }
  db.calendarReschedule(ev.id, next, nowSec);
}

/** Post everything due at `nowMs`. Exported for tests. */
export async function fireDue(nowMs = Date.now()) {
  if (!client) return;
  const due = db.calendarDue(Math.floor(nowMs / 1000));
  for (const ev of due) {
    // eslint-disable-next-line no-await-in-loop
    await fireEvent(ev);
  }
}

export function startTicker(c) {
  client = c;
  if (ticker) return;
  ticker = setInterval(() => {
    fireDue().catch((err) => console.error('[calendar] tick failed:', err?.message || err));
  }, TICK_EVERY_MS);
  ticker.unref?.();
}

export function stopTicker() {
  if (ticker) clearInterval(ticker);
  ticker = null;
}

/** Test seam. */
export function _setClient(c) {
  client = c;
}

export function _resetForTests() {
  stopTicker();
  client = null;
  WALL_FMT.clear();
}
