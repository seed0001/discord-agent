// Tools the AI can call. Ported from the Python bot's tools.py, starting
// with web_search — GitHub/sandbox/moderation/memory-recall/knowledge-base
// tools follow once their own persistence/identity pieces exist here.
import * as DDG from 'duck-duck-scrape';

const SEARCH_RESULTS = 5;
const RESULT_MAX_CHARS = 8000;

export const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: (
        'Search the web with DuckDuckGo. Use this for current events, '
        + "documentation, or anything you don't know or might be out of date on."
      ),
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'The search query' } },
        required: ['query'],
      },
    },
  },
];

export async function runTool(name, args) {
  try {
    if (name === 'web_search') return await webSearch(String(args.query || ''));
    return `Unknown tool: ${name}`;
  } catch (err) {
    console.warn(`[tools] ${name} failed:`, err.message);
    return `Tool ${name} failed: ${err.message}`;
  }
}

/** searchFn is injectable for testing (this sandbox's network egress
 * allowlist blocks duckduckgo.com directly — same category of restriction
 * hit earlier with api.github.com — so the live call can't be exercised
 * here; the wrapper logic below is tested against a fake instead). Real
 * call sites never pass it. */
export async function webSearch(query, searchFn = DDG.search) {
  if (!query) return 'Empty search query.';
  const { results } = await searchFn(query, { safeSearch: DDG.SafeSearchType.MODERATE });
  if (!results?.length) return 'No results found.';
  const text = results
    .slice(0, SEARCH_RESULTS)
    .map((r) => `${stripHtml(r.title)}\n${r.url}\n${stripHtml(r.description)}`)
    .join('\n\n');
  return text.slice(0, RESULT_MAX_CHARS);
}

function stripHtml(text) {
  return (text || '').replace(/<\/?[a-z][^>]*>/gi, '');
}
