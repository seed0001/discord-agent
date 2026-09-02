// The scheduler's own logic that doesn't require a live Discord guild —
// quiet hours (including the midnight-wrap case). The full evaluateGuild()
// decision cycle (cooldowns, daily caps, the duplicate-session guard) needs
// a real guild/member/channel and is covered by manual verification (see
// the plan's Verification section) rather than mocked here — the actual
// decision MATH it depends on (reach_out_drive, effectiveCooldownHours) is
// covered directly in state.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as db from '../../src/db.js';
import { inQuietHours } from '../../src/companion/scheduler.js';

function withDb(fn) {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nodebot-companion-test-'));
    db.initDb(path.join(dir, 'test.db'));
    try {
      await fn();
    } finally {
      db.closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

// 2024-01-01 12:00:00 UTC and neighbouring hours, as plain unix seconds —
// avoids any dependency on the test runner's local timezone.
const NOON = Date.UTC(2024, 0, 1, 12, 0, 0) / 1000;
const AT = (h, m = 0) => Date.UTC(2024, 0, 1, h, m, 0) / 1000;

test('no quiet hours configured -> never quiet', withDb(() => {
  assert.equal(inQuietHours('g1', NOON), false);
}));

test('a same-day window (e.g. 12:00-14:00) is quiet only inside it', withDb(() => {
  db.setSetting('g1', 'companion_quiet_hours_start', '12:00');
  db.setSetting('g1', 'companion_quiet_hours_end', '14:00');
  assert.equal(inQuietHours('g1', AT(11, 59)), false);
  assert.equal(inQuietHours('g1', AT(12, 0)), true);
  assert.equal(inQuietHours('g1', AT(13, 30)), true);
  assert.equal(inQuietHours('g1', AT(14, 0)), false);
}));

test('a window that wraps past midnight (e.g. 23:00-08:00) is quiet on both sides of midnight', withDb(() => {
  db.setSetting('g1', 'companion_quiet_hours_start', '23:00');
  db.setSetting('g1', 'companion_quiet_hours_end', '08:00');
  assert.equal(inQuietHours('g1', AT(22, 59)), false);
  assert.equal(inQuietHours('g1', AT(23, 30)), true);
  assert.equal(inQuietHours('g1', AT(2, 0)), true);
  assert.equal(inQuietHours('g1', AT(7, 59)), true);
  assert.equal(inQuietHours('g1', AT(8, 0)), false);
}));

test('an equal start/end (a misconfigured empty window) is never quiet', withDb(() => {
  db.setSetting('g1', 'companion_quiet_hours_start', '09:00');
  db.setSetting('g1', 'companion_quiet_hours_end', '09:00');
  assert.equal(inQuietHours('g1', AT(9, 0)), false);
}));

test('only start OR only end set -> quiet hours do not apply', withDb(() => {
  db.setSetting('g1', 'companion_quiet_hours_start', '23:00');
  assert.equal(inQuietHours('g1', AT(23, 30)), false);
}));

test('respects the per-guild calendar_timezone, not just UTC', withDb(() => {
  db.setSetting('g1', 'calendar_timezone', 'America/Chicago'); // UTC-6 in January
  db.setSetting('g1', 'companion_quiet_hours_start', '23:00');
  db.setSetting('g1', 'companion_quiet_hours_end', '08:00');
  // 05:30 America/Chicago == 11:30 UTC on this date — inside the window locally.
  assert.equal(inQuietHours('g1', AT(11, 30)), true);
  // 12:30 America/Chicago == 18:30 UTC — outside the window locally.
  assert.equal(inQuietHours('g1', AT(18, 30)), false);
}));
