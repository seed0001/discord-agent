// memory.js — the pure helpers plus the durability path against a real
// temp-file SQLite database. Consolidation itself makes a model call and is
// covered only where it's deterministic (parsing, preservation scoring).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as db from '../src/db.js';
import * as memory from '../src/memory.js';

function withDb(fn) {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nodebot-mem-'));
    db.initDb(path.join(dir, 'test.db'));
    memory._resetForTests();
    // Consolidation makes a live model call and runs fire-and-forget; off
    // here so these stay hermetic and can't outlive the database.
    memory._setConsolidationEnabled(false);
    try {
      await fn();
    } finally {
      db.closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

// -- parseConsolidation -----------------------------------------------------

test('parses a bare JSON consolidation reply', () => {
  const parsed = memory.parseConsolidation(
    '{"durable":"a fact","working":"live ctx","profiles":{"Travis":{"goals":"ship it"}}}',
  );
  assert.equal(parsed.durable, 'a fact');
  assert.equal(parsed.working, 'live ctx');
  assert.deepEqual(parsed.profiles.Travis, { goals: 'ship it' });
});

test('tolerates a fenced code block around the JSON', () => {
  const parsed = memory.parseConsolidation('```json\n{"durable":"x","working":"y"}\n```');
  assert.equal(parsed.durable, 'x');
  assert.equal(parsed.working, 'y');
  assert.deepEqual(parsed.profiles, {});
});

test('tolerates prose wrapped around the JSON object', () => {
  const parsed = memory.parseConsolidation('Sure! {"durable":"x","working":"y"} hope that helps');
  assert.equal(parsed.durable, 'x');
});

test('returns null for an unparseable reply so memory is left alone', () => {
  assert.equal(memory.parseConsolidation('I am not JSON at all'), null);
  assert.equal(memory.parseConsolidation('{"durable": broken'), null);
  assert.equal(memory.parseConsolidation(''), null);
});

test('a non-object profiles field degrades to empty rather than throwing', () => {
  const parsed = memory.parseConsolidation('{"durable":"x","working":"y","profiles":"nope"}');
  assert.deepEqual(parsed.profiles, {});
});

// -- preservation scoring ---------------------------------------------------

test('preservation is 1.0 when there is nothing substantive to lose', () => {
  assert.equal(memory.preservationRatio('a b c', ''), 1.0);
});

test('preservation catches a dropped member fact', () => {
  const raw = 'building a Discord bot called Max deployed on Railway using OpenRouter';
  assert.ok(memory.preservationRatio(raw, 'they mentioned a project') < 0.12);
});

test('preservation is high when specifics actually survived', () => {
  const raw = 'building a Discord bot called Max deployed on Railway using OpenRouter';
  const kept = 'Max is a Discord bot deployed on Railway, talking to OpenRouter';
  assert.ok(memory.preservationRatio(raw, kept) >= 0.5);
});

test('short technical tokens count, not just long words', () => {
  // The length-only filter used to throw away exactly the terms that carry
  // the meaning of a constraint fact.
  const tokens = memory.significantTokens('needs TLS on arm64 with 256mb');
  assert.ok(tokens.has('tls'));
  assert.ok(tokens.has('arm64'));
  assert.ok(tokens.has('256mb'));
});

// -- durability + recall ----------------------------------------------------

test('a recorded turn is persisted before any consolidation runs', withDb(() => {
  memory.recordTurn('1', 'Travis', 'the deploy is on Railway', { userId: '42', channel: 'general' });
  const pendingGuilds = db.getPendingTurnGuilds();
  assert.deepEqual(pendingGuilds, ['1']);
  const rows = db.getPendingTurns('1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, 'the deploy is on Railway');
  assert.equal(rows[0].speaker, 'Travis');
}));

test('an empty or whitespace-only turn is ignored', withDb(() => {
  memory.recordTurn('1', 'Travis', '   ');
  memory.recordTurn('1', 'Travis', '');
  assert.deepEqual(db.getPendingTurnGuilds(), []);
}));

test('the full text is persisted even though consolidation reads a truncated copy', withDb(() => {
  const long = 'x'.repeat(500);
  memory.recordTurn('1', 'Travis', long, { userId: '42' });
  assert.equal(db.getPendingTurns('1')[0].text.length, 500);
}));

test('recall searches the permanent log by member and keyword', withDb(() => {
  memory.recordTurn('1', 'Travis', 'the deploy is on Railway', { userId: '42', channel: 'general' });
  memory.recordTurn('1', 'Alice', 'I prefer Fly.io honestly', { userId: '43', channel: 'general' });

  const all = memory.recall('1');
  assert.match(all, /Railway/);
  assert.match(all, /Fly\.io/);

  const byMember = memory.recall('1', { member: 'Alice' });
  assert.match(byMember, /Fly\.io/);
  assert.doesNotMatch(byMember, /Railway/);

  const byKeyword = memory.recall('1', { query: 'Railway' });
  assert.match(byKeyword, /Railway/);
  assert.doesNotMatch(byKeyword, /Fly\.io/);
}));

test('recall reports cleanly when there is nothing to find', withDb(() => {
  assert.equal(memory.recall('1', { query: 'nothing here' }), 'No matching chat history found.');
}));

test('recall tags each line with where it was said', withDb(() => {
  memory.recordTurn('1', 'Travis', 'posted in text', { userId: '42', channel: 'general' });
  memory.recordTurn('1', 'Travis', 'said out loud', { userId: '42', channel: 'General', source: 'voice' });
  const log = memory.recall('1');
  // Each line is "[<date> <location>] speaker: text", so the location sits
  // at the end of the bracket, after the timestamp.
  assert.match(log, /#general\] Travis: posted in text/);
  assert.match(log, /voice\/General\] Travis: said out loud/);
}));

test('recall caps limit at 100 regardless of what the model asks for', withDb(() => {
  for (let i = 0; i < 120; i += 1) memory.recordTurn('1', 'Travis', `turn ${i}`, { userId: '42' });
  const lines = memory.recall('1', { limit: 5000 }).split('\n');
  assert.equal(lines.length, 100);
}));

// -- context building -------------------------------------------------------

test('context is empty when nothing has been learned yet', withDb(() => {
  assert.equal(memory.getContext('1'), '');
}));

test('context includes durable and working memory', withDb(() => {
  db.setMemory('1', 'durable', 'Travis runs the server');
  db.setMemory('1', 'working', 'currently porting to Node');
  const ctx = memory.getContext('1');
  assert.match(ctx, /DURABLE MEMORY/);
  assert.match(ctx, /Travis runs the server/);
  assert.match(ctx, /WORKING MEMORY/);
  assert.match(ctx, /currently porting to Node/);
}));

test("the speaker's profile card is loaded ahead of the guild-wide dump", withDb(() => {
  db.setMemory('1', 'durable', 'a big pile of unrelated guild facts');
  db.setMemory('1', 'profile:42', JSON.stringify({
    name: 'Travis', goals: 'ship the Node cutover', notes: 'hates retyping config',
  }));
  const ctx = memory.getContext('1', '42');
  assert.ok(ctx.indexOf('SPEAKER PROFILE') < ctx.indexOf('DURABLE MEMORY'),
    "the speaker's own card must come first, not be buried in the guild dump");
  assert.match(ctx, /ship the Node cutover/);
}));

test('a corrupt profile card is ignored rather than crashing context building', withDb(() => {
  db.setMemory('1', 'profile:42', 'not json');
  db.setMemory('1', 'durable', 'still works');
  const ctx = memory.getContext('1', '42');
  assert.match(ctx, /still works/);
  assert.doesNotMatch(ctx, /SPEAKER PROFILE/);
}));

// -- restart recovery -------------------------------------------------------

test('restorePendingTurns replays turns that never got consolidated', withDb(() => {
  memory.recordTurn('1', 'Travis', 'a wall of detail given right before a redeploy', { userId: '42' });
  // Simulate a restart: the in-process buffer is gone, the DB row is not.
  memory._resetForTests();
  memory.restorePendingTurns();
  // Recovery must not re-mark them consolidated on its own; the row is still
  // pending until a consolidation actually succeeds.
  assert.equal(db.getPendingTurns('1').length, 1);
}));

test('already-consolidated turns are not replayed', withDb(() => {
  memory.recordTurn('1', 'Travis', 'old news', { userId: '42' });
  db.markTurnsConsolidated('1', 1);
  assert.deepEqual(db.getPendingTurnGuilds(), []);
}));
