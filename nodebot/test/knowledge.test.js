import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as db from '../src/db.js';
import * as knowledge from '../src/knowledge.js';

function withDb(fn) {
  return () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nodebot-kb-test-'));
    db.initDb(path.join(dir, 'test.db'));
    try {
      fn();
    } finally {
      db.closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('slugify lowercases, hyphenates, strips punctuation', () => {
  assert.equal(knowledge.slugify('Spin Up A Node Repo'), 'spin-up-a-node-repo');
  assert.equal(knowledge.slugify('Deploy to Railway!! (quick)'), 'deploy-to-railway-quick');
  assert.equal(knowledge.slugify('   '), 'entry');
});

test('save requires both a title and content', withDb(() => {
  assert.match(knowledge.save('1', '', 'content'), /required/);
  assert.match(knowledge.save('1', 'title', ''), /required/);
}));

test('save reports new vs updated, and search finds it after', withDb(() => {
  const first = knowledge.save('1', 'Deploy', 'run npm start');
  assert.match(first, /Saved new/);
  const second = knowledge.save('1', 'Deploy', 'corrected steps');
  assert.match(second, /Updated existing/);
  assert.match(knowledge.search('1', 'corrected'), /corrected steps/);
}));

test('search reports no matches plainly', withDb(() => {
  assert.match(knowledge.search('1', 'nothing here'), /No matching/);
}));

test('listEntries shows titles, not content', withDb(() => {
  knowledge.save('1', 'Alpha', 'alpha content');
  knowledge.save('1', 'Beta', 'beta content');
  const list = knowledge.listEntries('1');
  assert.match(list, /Alpha/);
  assert.match(list, /Beta/);
  assert.doesNotMatch(list, /alpha content/);
}));

test('runTool dispatches kb_search/kb_list/kb_save and rejects unknown names', withDb(() => {
  assert.match(knowledge.runTool('1', 'kb_save', { title: 'X', content: 'Y' }), /Saved new/);
  assert.match(knowledge.runTool('1', 'kb_search', { query: 'X' }), /Y/);
  assert.match(knowledge.runTool('1', 'kb_list', {}), /X/);
  assert.match(knowledge.runTool('1', 'kb_nonsense', {}), /Unknown/);
}));

test('entries are isolated per guild', withDb(() => {
  knowledge.save('1', 'Guild One Thing', 'content');
  assert.match(knowledge.listEntries('2'), /empty/);
}));
