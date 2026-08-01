// Tools the AI can call. Ported from the Python bot's tools.py, starting
// with web_search — GitHub/sandbox/moderation/memory-recall/knowledge-base
// tools follow once their own persistence/identity pieces exist here.
import * as DDG from 'duck-duck-scrape';
import { BRAVE_SEARCH_API_KEY } from './config.js';

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

function formatResults(results) {
  if (!results?.length) return 'No results found.';
  const text = results
    .slice(0, SEARCH_RESULTS)
    .map((r) => `${stripHtml(r.title)}\n${r.url}\n${stripHtml(r.description)}`)
    .join('\n\n');
  return text.slice(0, RESULT_MAX_CHARS);
}

/** searchFn is injectable for testing (this sandbox's network egress
 * allowlist blocks duckduckgo.com directly — same category of restriction
 * hit earlier with api.github.com — so the live call can't be exercised
 * here; the wrapper logic below is tested against a fake instead). Real
 * call sites never pass it. */
export async function webSearch(query, searchFn = DDG.search) {
  if (!query) return 'Empty search query.';

  if (BRAVE_SEARCH_API_KEY) {
    try {
      return formatResults(await braveSearch(query));
    } catch (err) {
      console.warn('[tools] Brave search failed:', err.message);
    }
  }

  try {
    const { results } = await searchFn(query, { safeSearch: DDG.SafeSearchType.MODERATE });
    return formatResults(results);
  } catch (err) {
    console.warn('[tools] DuckDuckGo scrape failed:', err.message);
  }

  try {
    return formatResults(await ddgInstantSearch(query));
  } catch (err) {
    console.warn('[tools] DuckDuckGo instant API failed:', err.message);
  }

  return (
    'Web search is unavailable right now. DuckDuckGo blocks this server; '
    + 'set BRAVE_SEARCH_API_KEY in Railway for full search (free tier at '
    + 'https://brave.com/search/api).'
  );
}

async function braveSearch(query) {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(SEARCH_RESULTS));
  const resp = await fetch(url, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': BRAVE_SEARCH_API_KEY },
  });
  if (!resp.ok) {
    throw new Error(`Brave API ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  const data = await resp.json();
  return (data.web?.results || []).map((r) => ({
    title: r.title || '',
    url: r.url || '',
    description: r.description || '',
  }));
}

/** DuckDuckGo's lightweight JSON API — works from cloud hosts but only
 * returns an instant-answer abstract plus a handful of related links. */
async function ddgInstantSearch(query) {
  const url = new URL('https://api.duckduckgo.com/');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('no_html', '1');
  url.searchParams.set('skip_disambig', '1');
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`DDG instant API ${resp.status}`);
  const data = await resp.json();
  const results = [];
  if (data.AbstractText) {
    results.push({
      title: data.Heading || data.AbstractSource || 'Instant answer',
      url: data.AbstractURL || '',
      description: data.AbstractText,
    });
  }
  for (const topic of data.RelatedTopics || []) {
    if (topic.Text && topic.FirstURL) {
      results.push({ title: topic.Text, url: topic.FirstURL, description: '' });
    } else if (topic.Topics) {
      for (const sub of topic.Topics) {
        if (sub.Text && sub.FirstURL) {
          results.push({ title: sub.Text, url: sub.FirstURL, description: '' });
        }
      }
    }
    if (results.length >= SEARCH_RESULTS) break;
  }
  return results;
}

function stripHtml(text) {
  return (text || '').replace(/<\/?[a-z][^>]*>/gi, '');
}
