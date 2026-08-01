// The system prompt is assembled from settings plus the live command table,
// so these tests run against a real database and the real command loader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as db from '../src/db.js';
import { buildSystemPrompt, commandList } from '../src/systemPrompt.js';
import { SYSTEM_PROMPT, CAPABILITY_PROMPT, OWNER_NOTE, MEMBER_NOTE } from '../src/persona.js';
import { loadCommands } from '../src/load-commands.js';
import { TOOL_SCHEMAS } from '../src/tools.js';
import { KB_TOOL_SCHEMAS } from '../src/knowledge.js';
import { GITHUB_TOOL_SCHEMAS } from '../src/github.js';
import { REPO_TOOL_SCHEMAS } from '../src/textChat.js';
import { RECALL_TOOL_SCHEMA } from '../src/memory.js';
import { TOOL_SCHEMAS as AGENT_TOOL_SCHEMAS } from '../src/agentTools.js';

const guild = { id: '111', name: 'Test Server', memberCount: 42 };

function withDb(fn) {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nodebot-sysprompt-'));
    db.initDb(path.join(dir, 'test.db'));
    try {
      await fn();
    } finally {
      db.closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

async function realClient() {
  return { user: { displayName: 'Max', username: 'Max' }, commands: await loadCommands() };
}

// -- assembly ----------------------------------------------------------------

test('both halves of the persona are present', withDb(async () => {
  const out = buildSystemPrompt({ client: await realClient(), guild });
  assert.ok(out.includes(SYSTEM_PROMPT), 'character persona missing');
  assert.ok(out.includes(CAPABILITY_PROMPT), 'capability persona missing');
}));

test('he is told which server he is actually running', withDb(async () => {
  const out = buildSystemPrompt({ client: await realClient(), guild });
  assert.match(out, /You are Max, the bot that manages the Discord server "Test Server" \(42 members\)/);
}));

test('the real slash commands are listed', withDb(async () => {
  const out = buildSystemPrompt({ client: await realClient(), guild });
  assert.match(out, /- \/ban: /);
  assert.match(out, /- \/warnings: /);
}));

test('the owner and member notes are mutually exclusive', withDb(async () => {
  const client = await realClient();
  const asOwner = buildSystemPrompt({ client, guild, owner: true });
  const asMember = buildSystemPrompt({ client, guild, owner: false });
  assert.ok(asOwner.includes(OWNER_NOTE) && !asOwner.includes(MEMBER_NOTE));
  assert.ok(asMember.includes(MEMBER_NOTE) && !asMember.includes(OWNER_NOTE));
}));

test('memory is appended when there is any, and omitted when not', withDb(async () => {
  const client = await realClient();
  assert.match(
    buildSystemPrompt({ client, guild, memory: 'they prefer tabs' }),
    /What you remember \(maintained across restarts\):\nthey prefer tabs/,
  );
  assert.ok(!buildSystemPrompt({ client, guild }).includes('What you remember'));
}));

test('a customised persona replaces the default, which is the point of it', withDb(async () => {
  db.setSetting('111', 'ai_system_prompt', 'You are a laconic robot.');
  const out = buildSystemPrompt({ client: await realClient(), guild });
  assert.ok(out.includes('You are a laconic robot.'));
  assert.ok(!out.includes(SYSTEM_PROMPT));
  // ...and the capability half is untouched by that.
  assert.ok(out.includes(CAPABILITY_PROMPT));
}));

test('an untouched guild gets the current capability text, not a frozen copy', withDb(async () => {
  assert.equal(db.getSetting('999', 'ai_capability_prompt'), CAPABILITY_PROMPT);
}));

test('commandList is sorted and survives a client with no commands', async () => {
  const names = commandList(await realClient()).split('\n').map((l) => l.split(':')[0]);
  assert.deepEqual(names, [...names].sort());
  assert.equal(commandList({}), '');
  assert.equal(commandList(undefined), '');
});

// -- the capability prompt must not claim things that don't exist ------------

const REAL_TOOLS = new Set([
  ...TOOL_SCHEMAS, ...KB_TOOL_SCHEMAS, ...GITHUB_TOOL_SCHEMAS,
  ...REPO_TOOL_SCHEMAS, RECALL_TOOL_SCHEMA, ...AGENT_TOOL_SCHEMAS,
].map((t) => t.function.name));

test('every tool the capability prompt names actually exists', () => {
  // Catches the failure this prompt exists to prevent: the Python original
  // advertised sandbox_* tools and eight slash commands this bot never had.
  const named = CAPABILITY_PROMPT.match(
    /\b(?:kb|github|repo|sandbox)_[a-z_]+|\bweb_search\b|\brecall_chat_log\b/g,
  ) || [];
  assert.ok(named.length > 5, 'expected the prompt to name real tools');
  for (const name of new Set(named)) {
    assert.ok(REAL_TOOLS.has(name), `capability prompt claims a tool that does not exist: ${name}`);
  }
});

test('the capability prompt promises no sandbox or write access', () => {
  assert.ok(!/sandbox_/.test(CAPABILITY_PROMPT));
  assert.match(CAPABILITY_PROMPT, /READ-ONLY by design/);
  assert.match(CAPABILITY_PROMPT, /no sandbox and no way to write to a repository/);
});

test('every slash command the capability prompt names actually exists', async () => {
  const commands = await loadCommands();
  const existing = new Set([...commands.values()].map((c) => c.data.toJSON().name));
  // The slash must start a word — otherwise "welcome/goodbye messages" reads
  // as a reference to a /goodbye command.
  for (const m of CAPABILITY_PROMPT.matchAll(/(?:^|[\s([{"'])\/([a-z]+)\b/g)) {
    assert.ok(existing.has(m[1]), `capability prompt claims /${m[1]}, which does not exist`);
  }
});
