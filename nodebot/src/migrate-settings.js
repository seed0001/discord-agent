#!/usr/bin/env node
// One-off migration: copy guild_settings from the Python bot's database into
// the Node bot's, so the cutover doesn't mean retyping configuration.
//
//     node nodebot/src/migrate-settings.js [--from /data/bot.db] [--to /data/nodebot.db]
//
// Settings ONLY. Chat history, memories, warnings and mod logs are
// deliberately not copied: the Python schema stores Discord snowflake IDs as
// INTEGER, and any id past 2^53 is already corrupt by the time SQLite hands
// it back as a JS number. Settings are keyed by guild id as text and carry
// no such ids in their values, so they cross safely; the bulk tables do not.
//
// Idempotent: re-running overwrites the same keys with the same values.
// Non-destructive: nothing is written to the source database, and existing
// Node-side settings are only replaced for keys present in the source.
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

// Settings whose values are Discord snowflake ids. The Python side stored
// these as JSON already, but they are re-stringified here so a numeric id
// can never arrive on the Node side as a float.
const ID_VALUED_KEYS = new Set(['log_channel', 'welcome_channel', 'autorole']);

// Keys that exist only in the Python bot and mean nothing here.
const SKIP_KEYS = new Set([]);

export function migrateSettings(fromPath, toPath, { dryRun = false } = {}) {
  if (!existsSync(fromPath)) throw new Error(`source database not found: ${fromPath}`);

  const source = new DatabaseSync(fromPath, { readOnly: true });
  let rows;
  try {
    rows = source.prepare('SELECT guild_id, key, value FROM guild_settings').all();
  } catch (err) {
    source.close();
    throw new Error(`could not read guild_settings from ${fromPath}: ${err.message}`);
  }
  source.close();

  const target = new DatabaseSync(toPath);
  // Match db.js's schema exactly — running this before the bot's first boot
  // must not create a table the bot then disagrees with.
  target.exec(`CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id TEXT NOT NULL,
    key      TEXT NOT NULL,
    value    TEXT NOT NULL,
    PRIMARY KEY (guild_id, key)
  )`);

  const upsert = target.prepare(
    'INSERT INTO guild_settings (guild_id, key, value) VALUES (?, ?, ?) '
    + 'ON CONFLICT (guild_id, key) DO UPDATE SET value = excluded.value',
  );

  const migrated = [];
  const skipped = [];
  for (const row of rows) {
    if (SKIP_KEYS.has(row.key)) {
      skipped.push(`${row.key} (not used by the Node bot)`);
      continue;
    }
    let value = row.value;
    if (ID_VALUED_KEYS.has(row.key) && /^\s*\d+\s*$/.test(value)) {
      // Quote the digits TEXTUALLY. Going via JSON.parse would round-trip
      // the id through a double and silently corrupt any snowflake past
      // 2^53 before we ever got the chance to stringify it —
      // 1408180389180211270 comes back as ...200.
      value = `"${value.trim()}"`;
    }
    // 'null', already-quoted strings, and anything malformed pass through
    // untouched rather than being guessed at.
    if (!dryRun) upsert.run(String(row.guild_id), row.key, value);
    migrated.push(`${row.guild_id}/${row.key}`);
  }
  target.close();
  return { migrated, skipped };
}

function parseArgs(argv) {
  const args = { from: '/data/bot.db', to: '/data/nodebot.db', dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--from') args.from = argv[i + 1];
    else if (argv[i] === '--to') args.to = argv[i + 1];
    else if (argv[i] === '--dry-run') args.dryRun = true;
  }
  return args;
}

// Only run when invoked directly, so importing this from a test is safe.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const args = parseArgs(process.argv.slice(2));
  try {
    const { migrated, skipped } = migrateSettings(args.from, args.to, { dryRun: args.dryRun });
    console.log(`${args.dryRun ? '[dry run] would migrate' : 'Migrated'} `
      + `${migrated.length} setting(s) from ${args.from} -> ${args.to}`);
    for (const key of migrated) console.log(`  ${key}`);
    for (const key of skipped) console.log(`  skipped: ${key}`);
  } catch (err) {
    console.error(`Migration failed: ${err.message}`);
    process.exit(1);
  }
}
