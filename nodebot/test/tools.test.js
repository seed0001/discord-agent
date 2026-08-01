// duck-duck-scrape's live network call can't be exercised from this
// sandbox (duckduckgo.com is blocked by its egress allowlist, confirmed
// via a raw fetch returning 403 "Host not in allowlist" — a testing-
// environment restriction, not a code issue), so these test the wrapper
// logic (formatting, truncation, empty-result handling) against a fake
// search function injected in place of the real one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webSearch, runTool } from '../src/tools.js';

test('empty query short-circuits without calling search', async () => {
  let called = false;
  const fakeSearch = async () => { called = true; return { results: [] }; };
  const result = await webSearch('', fakeSearch);
  assert.equal(result, 'Empty search query.');
  assert.equal(called, false);
});

test('no results is reported plainly', async () => {
  const result = await webSearch('nothing matches this', async () => ({ results: [] }));
  assert.equal(result, 'No results found.');
});

test('formats title/url/description and strips HTML tags DDG embeds', async () => {
  const fakeSearch = async () => ({
    results: [
      { title: 'Node.js <b>docs</b>', url: 'https://nodejs.org', description: 'The <b>official</b> site' },
    ],
  });
  const result = await webSearch('node.js', fakeSearch);
  assert.equal(result, 'Node.js docs\nhttps://nodejs.org\nThe official site');
});

test('caps at 5 results even when more come back', async () => {
  const results = Array.from({ length: 10 }, (_, i) => (
    { title: `Result ${i}`, url: `https://example.com/${i}`, description: 'x' }
  ));
  const result = await webSearch('query', async () => ({ results }));
  assert.equal((result.match(/Result \d+/g) || []).length, 5);
  assert.ok(result.includes('Result 4'));
  assert.ok(!result.includes('Result 5'));
});

test('runTool dispatches web_search and reports unknown tools', async () => {
  const unknown = await runTool('not_a_real_tool', {});
  assert.match(unknown, /^Unknown tool/);
});

test('falls back to instant-answer results when scrape searchFn throws', async () => {
  const fakeSearch = async () => { throw new Error('DDG detected an anomaly'); };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /api\.duckduckgo\.com/);
    return {
      ok: true,
      async json() {
        return {
          AbstractText: 'Tropical climate overview.',
          Heading: 'Tanzania',
          AbstractURL: 'https://example.com/tz',
          RelatedTopics: [{ Text: 'Dar es Salaam', FirstURL: 'https://example.com/dsm' }],
        };
      },
    };
  };
  try {
    const result = await webSearch('Tanzania climate', fakeSearch);
    assert.match(result, /Tropical climate overview/);
    assert.match(result, /Dar es Salaam/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
