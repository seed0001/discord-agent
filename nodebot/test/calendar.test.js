import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as db from '../src/db.js';
import * as calendar from '../src/calendar.js';

function withDb(fn) {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nodebot-cal-test-'));
    db.initDb(path.join(dir, 'test.db'));
    try {
      await fn();
    } finally {
      calendar._resetForTests();
      db.closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

// -- fakes ----------------------------------------------------------------

function coll(items) {
  const m = new Map(items.map((x) => [x.id, x]));
  m.find = (pred) => {
    for (const v of m.values()) if (pred(v)) return v;
    return undefined;
  };
  return m;
}

function makeChannel(id, name) {
  const channel = {
    id,
    name,
    isTextBased: () => true,
    sent: [],
    async send(payload) { channel.sent.push(payload); return payload; },
  };
  return channel;
}

function makeGuild(id, { channels = [], roles = [] } = {}) {
  return { id, channels: { cache: coll(channels) }, roles: { cache: coll(roles) } };
}

const msg = (guild, channel, userId) => ({ guild, channel, author: { id: userId } });

// Discord IDs are numeric snowflakes; the resolvers rely on that.
const U1 = '111111111111111111';
const U2 = '222222222222222222';
const OWNER = '999999999999999999';
const CH1 = '100000000000000001';
const CH2 = '100000000000000002';

// -- timezone / when parsing --------------------------------------------

test('parseWhen: relative offsets', () => {
  const now = Date.UTC(2026, 7, 27, 12, 0, 0);
  assert.equal(calendar.parseWhen('+30m', 'UTC', now), now / 1000 + 1800);
  assert.equal(calendar.parseWhen('2h', 'UTC', now), now / 1000 + 7200);
  assert.equal(calendar.parseWhen('1 day', 'UTC', now), now / 1000 + 86400);
});

test('parseWhen: bare date defaults to 09:00 local', () => {
  const ts = calendar.parseWhen('2026-08-28', 'America/Chicago');
  const w = calendar.wallParts(ts, 'America/Chicago');
  assert.equal(w.hour, 9);
  assert.equal(w.minute, 0);
  assert.equal(w.day, 28);
});

test('parseWhen: naive datetime is read in the given zone, not UTC', () => {
  const chicago = calendar.parseWhen('2026-08-28 15:00', 'America/Chicago');
  const utc = calendar.parseWhen('2026-08-28 15:00', 'UTC');
  // Chicago is UTC-5 in August, so its 15:00 is a later instant than UTC 15:00.
  assert.equal(chicago - utc, 5 * 3600);
});

test('parseWhen: explicit offset is honoured as-is', () => {
  assert.equal(
    calendar.parseWhen('2026-08-28T15:00:00Z', 'America/Chicago'),
    Math.floor(Date.UTC(2026, 7, 28, 15, 0, 0) / 1000),
  );
});

test('parseWhen: junk throws CalendarError', () => {
  assert.throws(() => calendar.parseWhen('whenever', 'UTC'), calendar.CalendarError);
  assert.throws(() => calendar.parseWhen('', 'UTC'), calendar.CalendarError);
});

test('validTimezone', () => {
  assert.equal(calendar.validTimezone('America/Chicago'), true);
  assert.equal(calendar.validTimezone('Europe/London'), true);
  assert.equal(calendar.validTimezone('Mars/Olympus'), false);
  assert.equal(calendar.validTimezone(''), false);
});

// -- recurrence --------------------------------------------------------

test('nextOccurrence: once has no next', () => {
  assert.equal(calendar.nextOccurrence(1_000_000, 'once', 'UTC'), null);
});

test('nextOccurrence: hourly adds an hour', () => {
  assert.equal(calendar.nextOccurrence(1_000_000, 'hourly', 'UTC'), 1_003_600);
});

test('nextOccurrence: daily keeps the wall-clock time across a DST change', () => {
  // US DST ends 2026-11-01. A 09:00 daily reminder on 10-31 must still be 09:00
  // local on 11-01, even though the UTC gap is 25 hours that day.
  const start = calendar.parseWhen('2026-10-31 09:00', 'America/Chicago');
  const next = calendar.nextOccurrence(start, 'daily', 'America/Chicago');
  const w = calendar.wallParts(next, 'America/Chicago');
  assert.equal(w.hour, 9);
  assert.equal(w.day, 1);
  assert.equal(w.month, 11);
  assert.equal(next - start, 25 * 3600);
});

test('nextOccurrence: weekdays skips the weekend', () => {
  // 2026-08-28 is a Friday.
  const fri = calendar.parseWhen('2026-08-28 09:00', 'UTC');
  const mon = calendar.nextOccurrence(fri, 'weekdays', 'UTC');
  assert.equal(calendar.wallParts(mon, 'UTC').weekday, 1); // Monday
  assert.equal(calendar.wallParts(mon, 'UTC').day, 31);
});

test('nextOccurrence: monthly clamps to the last day of a short month', () => {
  const jan31 = calendar.parseWhen('2026-01-31 08:00', 'UTC');
  const feb = calendar.nextOccurrence(jan31, 'monthly', 'UTC');
  assert.equal(calendar.wallParts(feb, 'UTC').month, 2);
  assert.equal(calendar.wallParts(feb, 'UTC').day, 28);
});

// -- tools ------------------------------------------------------------

test('calendar_add schedules, calendar_list shows it', withDb(async () => {
  const chan = makeChannel(CH1, 'general');
  const guild = makeGuild('g1', { channels: [chan] });
  const add = await calendar.execute(msg(guild, chan, U1), 'calendar_add', {
    title: 'standup', when: '+1h',
  }, false);
  assert.match(add, /Scheduled #1: "standup"/);

  const list = await calendar.execute(msg(guild, chan, U1), 'calendar_list', {}, false);
  assert.match(list, /#1: standup/);

  const row = db.calendarGet('g1', 1);
  assert.equal(row.channel_id, CH1);
  assert.equal(row.recurrence, 'once');
  assert.equal(row.created_by, U1);
}));

test('calendar_add rejects a past one-off and an unknown recurrence', withDb(async () => {
  const chan = makeChannel(CH1, 'general');
  const guild = makeGuild('g1', { channels: [chan] });
  assert.match(
    await calendar.execute(msg(guild, chan, U1), 'calendar_add', { title: 'x', when: '2000-01-01 00:00' }, false),
    /in the past/,
  );
  assert.match(
    await calendar.execute(msg(guild, chan, U1), 'calendar_add',
      { title: 'x', when: '+1h', recurrence: 'fortnightly' }, false),
    /recurrence must be one of/,
  );
}));

test('a recurring event whose first slot is past rolls forward, not fires now', withDb(async () => {
  const chan = makeChannel(CH1, 'general');
  const guild = makeGuild('g1', { channels: [chan] });
  await calendar.execute(msg(guild, chan, U1), 'calendar_add', {
    title: 'daily 9am', when: '2026-01-01 09:00', recurrence: 'daily',
  }, false);
  const row = db.calendarGet('g1', 1);
  assert.ok(row.next_fire > Math.floor(Date.now() / 1000), 'next_fire should be in the future');
  assert.equal(calendar.wallParts(row.next_fire, 'UTC').hour, 9);
}));

test('non-owner cannot ping a role, @everyone, or post to another channel', withDb(async () => {
  const here = makeChannel(CH1, 'general');
  const there = makeChannel(CH2, 'announcements');
  const role = { id: 'r1', name: 'team' };
  const guild = makeGuild('g1', { channels: [here, there], roles: [role] });

  assert.match(
    await calendar.execute(msg(guild, here, U1), 'calendar_add',
      { title: 'x', when: '+1h', notify: 'team' }, false),
    /only the owner can set a reminder to ping/,
  );
  assert.match(
    await calendar.execute(msg(guild, here, U1), 'calendar_add',
      { title: 'x', when: '+1h', notify: 'everyone' }, false),
    /only the owner can set a reminder to ping/,
  );
  assert.match(
    await calendar.execute(msg(guild, here, U1), 'calendar_add',
      { title: 'x', when: '+1h', channel: CH2 }, false),
    /only the owner can schedule a reminder for another channel/,
  );
}));

test('owner can ping @everyone and it is stored + scoped on send', withDb(async () => {
  const chan = makeChannel(CH1, 'general');
  const guild = makeGuild('g1', { channels: [chan] });
  await calendar.execute(msg(guild, chan, OWNER), 'calendar_add', {
    title: 'party', when: '+1h', notify: 'everyone',
  }, true);
  assert.equal(db.calendarGet('g1', 1).mention, '@everyone');
}));

test('notify:me pings just the requester', withDb(async () => {
  const chan = makeChannel(CH1, 'general');
  const guild = makeGuild('g1', { channels: [chan] });
  await calendar.execute(msg(guild, chan, U1), 'calendar_add', {
    title: 'take a break', when: '+1h', notify: 'me',
  }, false);
  assert.equal(db.calendarGet('g1', 1).mention, `<@${U1}>`);
}));

test('only the creator or owner can update/cancel', withDb(async () => {
  const chan = makeChannel(CH1, 'general');
  const guild = makeGuild('g1', { channels: [chan] });
  await calendar.execute(msg(guild, chan, U1), 'calendar_add', { title: 'mine', when: '+1h' }, false);

  assert.match(
    await calendar.execute(msg(guild, chan, U2), 'calendar_cancel', { id: 1 }, false),
    /set by someone else/,
  );
  assert.match(
    await calendar.execute(msg(guild, chan, U2), 'calendar_update', { id: 1, title: 'hijacked' }, false),
    /set by someone else/,
  );
  // The owner can.
  assert.match(
    await calendar.execute(msg(guild, chan, OWNER), 'calendar_update', { id: 1, title: 'fixed' }, true),
    /Updated reminder #1/,
  );
  assert.equal(db.calendarGet('g1', 1).title, 'fixed');
  // And the creator can cancel their own.
  assert.match(
    await calendar.execute(msg(guild, chan, U1), 'calendar_cancel', { id: 1 }, false),
    /Cancelled reminder #1/,
  );
  assert.equal(db.calendarGet('g1', 1), null);
}));

// -- scheduler -------------------------------------------------------

test('fireDue posts a due one-off and deactivates it', withDb(async () => {
  const chan = makeChannel(CH1, 'general');
  const guild = makeGuild('g1', { channels: [chan] });
  calendar._setClient({ user: { username: 'Max' }, guilds: { cache: coll([guild]) } });

  db.calendarAdd('g1', {
    title: 'ping', details: 'wake up', nextFire: Math.floor(Date.now() / 1000) - 5,
    recurrence: 'once', channelId: CH1, mention: `<@${U1}>`, createdBy: U1,
  });

  await calendar.fireDue();

  assert.equal(chan.sent.length, 1);
  assert.match(chan.sent[0].content, /ping/);
  assert.match(chan.sent[0].content, /wake up/);
  assert.deepEqual(chan.sent[0].allowedMentions, { users: [U1] });
  assert.equal(db.calendarGet('g1', 1).active, 0);
}));

test('fireDue rolls a recurring event forward instead of deactivating', withDb(async () => {
  const chan = makeChannel(CH1, 'general');
  const guild = makeGuild('g1', { channels: [chan] });
  calendar._setClient({ user: { username: 'Max' }, guilds: { cache: coll([guild]) } });

  const start = calendar.parseWhen('2026-01-01 09:00', 'UTC');
  db.calendarAdd('g1', {
    title: 'daily', nextFire: start, recurrence: 'daily', channelId: CH1, createdBy: U1,
  });

  await calendar.fireDue();

  const row = db.calendarGet('g1', 1);
  assert.equal(row.active, 1);
  assert.ok(row.next_fire > Math.floor(Date.now() / 1000), 'should be scheduled ahead of now');
  assert.equal(calendar.wallParts(row.next_fire, 'UTC').hour, 9);
}));

test('fireDue deactivates an event whose guild the bot has left', withDb(async () => {
  calendar._setClient({ user: { username: 'Max' }, guilds: { cache: coll([]) } });
  db.calendarAdd('gone', {
    title: 'orphan', nextFire: Math.floor(Date.now() / 1000) - 5,
    recurrence: 'daily', channelId: CH1, createdBy: U1,
  });
  await calendar.fireDue();
  assert.equal(db.calendarGet('gone', 1).active, 0);
}));
