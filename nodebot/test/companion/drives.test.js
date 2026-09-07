// Her internal-life pressure engine (companion/drives.js) — pure
// pressure-driven phase transitions, no wall-clock time anywhere. Mirrors
// state.test.js's shape: pure-function tests for tick()/nextPhase(), a
// withDb-backed round trip for load()/save()/forcePhase().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as db from '../../src/db.js';
import * as drivesMod from '../../src/companion/drives.js';

function withDb(fn) {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nodebot-companion-drives-test-'));
    db.initDb(path.join(dir, 'test.db'));
    try {
      await fn();
    } finally {
      db.closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function baseDrives(overrides = {}) {
  return {
    energy: 0.8,
    restlessness: 0.3,
    boredom: 0.3,
    socialPull: 0.3,
    phase: 'work',
    phaseStartedAt: 1_000_000,
    updatedAt: 1_000_000,
    ...overrides,
  };
}

// -- tick() decay math --------------------------------------------------

test('energy recovers toward 1 during sleep', () => {
  const drives = baseDrives({ phase: 'sleep', energy: 0.2 });
  const ticked = drivesMod.tick(drives, 1_000_000 + 3600 * 4);
  assert.ok(ticked.energy > 0.2, `expected energy to rise, got ${ticked.energy}`);
  assert.ok(ticked.energy < 1, 'should not reach the ceiling instantly');
});

test('energy depletes toward 0 while working', () => {
  const drives = baseDrives({ phase: 'work', energy: 0.8 });
  const ticked = drivesMod.tick(drives, 1_000_000 + 3600 * 4);
  assert.ok(ticked.energy < 0.8, `expected energy to fall, got ${ticked.energy}`);
});

test('boredom builds during work, restlessness decays', () => {
  const drives = baseDrives({
    phase: 'work', restlessness: 0.5, boredom: 0.2,
  });
  const ticked = drivesMod.tick(drives, 1_000_000 + 3600 * 4);
  assert.ok(ticked.boredom > 0.2, `expected boredom to rise, got ${ticked.boredom}`);
  assert.ok(ticked.restlessness < 0.5, `expected restlessness to fall, got ${ticked.restlessness}`);
});

test('restlessness builds during relax, boredom decays', () => {
  const drives = baseDrives({
    phase: 'relax', restlessness: 0.2, boredom: 0.5,
  });
  const ticked = drivesMod.tick(drives, 1_000_000 + 3600 * 4);
  assert.ok(ticked.restlessness > 0.2, `expected restlessness to rise, got ${ticked.restlessness}`);
  assert.ok(ticked.boredom < 0.5, `expected boredom to fall, got ${ticked.boredom}`);
});

test('a zero or negative gap is a no-op', () => {
  const drives = baseDrives({ energy: 0.42 });
  const ticked = drivesMod.tick(drives, 1_000_000);
  assert.equal(ticked.energy, 0.42);
});

// -- nextPhase() transition rules ----------------------------------------

test('energy hitting the sleep floor forces sleep regardless of other drives', () => {
  const drives = baseDrives({
    phase: 'work', energy: 0.1, restlessness: 0.9, boredom: 0.1, socialPull: 0.1,
  });
  assert.equal(drivesMod.nextPhase(drives), 'sleep');
});

test('asleep with energy still low stays asleep', () => {
  const drives = baseDrives({ phase: 'sleep', energy: 0.5 });
  assert.equal(drivesMod.nextPhase(drives), 'sleep');
});

test('asleep with energy recovered wakes into the highest of the other three drives', () => {
  const drives = baseDrives({
    phase: 'sleep', energy: 0.9, restlessness: 0.9, boredom: 0.2, socialPull: 0.1,
  });
  assert.equal(drivesMod.nextPhase(drives), 'work');
});

test('wake favors relax when boredom is the highest drive', () => {
  const drives = baseDrives({
    phase: 'sleep', energy: 0.9, restlessness: 0.2, boredom: 0.9, socialPull: 0.1,
  });
  assert.equal(drivesMod.nextPhase(drives), 'relax');
});

test('wake favors social when social_pull is the highest drive', () => {
  const drives = baseDrives({
    phase: 'sleep', energy: 0.9, restlessness: 0.2, boredom: 0.1, socialPull: 0.9,
  });
  assert.equal(drivesMod.nextPhase(drives), 'social');
});

test('high boredom switches work to relax', () => {
  const drives = baseDrives({ phase: 'work', boredom: 0.9 });
  assert.equal(drivesMod.nextPhase(drives), 'relax');
});

test('high restlessness switches relax to work', () => {
  const drives = baseDrives({ phase: 'relax', restlessness: 0.9 });
  assert.equal(drivesMod.nextPhase(drives), 'work');
});

test('social_pull crossing the threshold outranks boredom/restlessness and switches to social', () => {
  const fromWork = baseDrives({ phase: 'work', boredom: 0.9, socialPull: 0.9 });
  assert.equal(drivesMod.nextPhase(fromWork), 'social');
  const fromRelax = baseDrives({ phase: 'relax', restlessness: 0.9, socialPull: 0.9 });
  assert.equal(drivesMod.nextPhase(fromRelax), 'social');
});

test('in social, high social_pull holds even if boredom/restlessness are also high', () => {
  const drives = baseDrives({
    phase: 'social', socialPull: 0.9, boredom: 0.9, restlessness: 0.9,
  });
  assert.equal(drivesMod.nextPhase(drives), 'social');
});

test('in social, social_pull fading below the satisfied floor drops to whichever of restlessness/boredom is higher', () => {
  const toWork = baseDrives({
    phase: 'social', socialPull: 0.1, restlessness: 0.6, boredom: 0.2,
  });
  assert.equal(drivesMod.nextPhase(toWork), 'work');
  const toRelax = baseDrives({
    phase: 'social', socialPull: 0.1, restlessness: 0.2, boredom: 0.6,
  });
  assert.equal(drivesMod.nextPhase(toRelax), 'relax');
});

test('no threshold crossed holds the current phase', () => {
  const drives = baseDrives({
    phase: 'work', energy: 0.5, restlessness: 0.3, boredom: 0.3, socialPull: 0.3,
  });
  assert.equal(drivesMod.nextPhase(drives), 'work');
});

// -- load()/save()/forcePhase() round trip -------------------------------

test('load() on a fresh guild returns sane defaults without persisting anything', withDb(() => {
  const drives = drivesMod.load('g1', 1_000_000);
  assert.equal(drives.phase, 'work');
  assert.equal(db.getCompanionDrives('g1'), null, 'load() must not persist on its own');
}));

// db.saveCompanionDrives (like saveCompanionState) always stamps updated_at
// with the real wall clock, not a caller-supplied timestamp — so these
// round-trip tests can't fake a multi-hour decay gap across a save/reload
// boundary (same constraint state.test.js's own DB round-trip test lives
// with). tick()/nextPhase()'s pure math is already covered above with a
// controlled clock; these only need to confirm values persist correctly and
// that a phase already past its threshold AT SAVE TIME is detected on load,
// which doesn't depend on any elapsed real time.

test('save() then load() round-trips the stored drive values', withDb(() => {
  drivesMod.save('g1', baseDrives({
    phase: 'sleep', energy: 0.42, restlessness: 0.11, boredom: 0.22, socialPull: 0.33,
  }));
  const drives = drivesMod.load('g1');
  assert.equal(drives.phase, 'sleep');
  assert.ok(Math.abs(drives.energy - 0.42) < 0.01, `expected energy to round-trip, got ${drives.energy}`);
  assert.ok(Math.abs(drives.restlessness - 0.11) < 0.01);
  assert.ok(Math.abs(drives.boredom - 0.22) < 0.01);
  assert.ok(Math.abs(drives.socialPull - 0.33) < 0.01);
}));

test('load() reports phaseChanged and previousPhase when the stored drives are already past a threshold', withDb(() => {
  drivesMod.save('g1', baseDrives({ phase: 'work', boredom: 0.9 }));
  const drives = drivesMod.load('g1');
  assert.equal(drives.phaseChanged, true);
  assert.equal(drives.previousPhase, 'work');
  assert.equal(drives.phase, 'relax');
}));

test('load() reports no change when the stored phase is still valid', withDb(() => {
  drivesMod.save('g1', baseDrives({ phase: 'work', boredom: 0.3 }));
  const drives = drivesMod.load('g1');
  assert.equal(drives.phaseChanged, false);
  assert.equal(drives.phase, 'work');
}));

test('forcePhase() snaps to a phase and holds it (does not immediately re-transition)', withDb(() => {
  drivesMod.forcePhase('g1', 'sleep', 1_000_000);
  const drives = drivesMod.load('g1', 1_000_000 + 60);
  assert.equal(drives.phase, 'sleep');
  assert.equal(drives.phaseChanged, false);
}));

test('forcePhase() rejects an unknown phase name', withDb(() => {
  assert.throws(() => drivesMod.forcePhase('g1', 'nonsense'));
}));
