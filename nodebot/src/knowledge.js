// Procedural memory — ported from the Python bot's knowledge.py. Separate
// from tools.js because these are guild-scoped (need a guildId the
// generic tool dispatch doesn't carry), same reason the Python bot routes
// kb_* tool calls separately from its generic tools.run_tool.
import * as db from './db.js';

const SLUG_MAX = 80;
const SEARCH_LIMIT = 10;

export function slugify(title) {
  const slug = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (slug || 'entry').slice(0, SLUG_MAX);
}

function formatEntries(entries, withContent) {
  if (!entries.length) return 'No matching knowledge base entries.';
  return entries
    .map((e) => `### ${e.title} (slug: ${e.slug})${withContent ? `\n${e.content}` : ''}`)
    .join('\n\n');
}

export function search(guildId, query) {
  return formatEntries(db.kbSearch(guildId, query, SEARCH_LIMIT), true);
}

export function listEntries(guildId) {
  const entries = db.kbList(guildId);
  if (!entries.length) return 'Knowledge base is empty.';
  return entries.map((e) => `- ${e.title} (slug: ${e.slug})`).join('\n');
}

export function save(guildId, title, content) {
  title = (title || '').trim();
  content = (content || '').trim();
  if (!title || !content) return 'Both a title and content are required to save a knowledge base entry.';
  const slug = slugify(title);
  const existing = db.kbGet(guildId, slug);
  db.kbSave(guildId, slug, title, content);
  return existing ? `Updated existing entry '${title}'.` : `Saved new knowledge base entry '${title}'.`;
}

export const KB_TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'kb_search',
      description: (
        'Search your knowledge base of known procedures ("how to do X") by '
        + "keyword. Check this BEFORE improvising an unfamiliar multi-step "
        + "task or asking how to do something — if there's a matching entry, "
        + 'follow it instead of re-figuring it out or asking again.'
      ),
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Keyword(s) to search titles/content for' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'kb_list',
      description: "List every knowledge base entry's title (no content) — use to see what's already known.",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'kb_save',
      description: (
        'Save or update a knowledge base entry — a reusable procedure for '
        + 'how to do something. Use this once a new procedure is confirmed '
        + '(you figured it out, or someone just walked you through it) so '
        + "it never has to be re-explained. Saving with the same title as "
        + 'an existing entry overwrites/corrects it.'
      ),
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: "Short, specific title, e.g. 'spin up a Node repo'" },
          content: { type: 'string', description: 'The actual procedure — concrete steps, commands, gotchas' },
        },
        required: ['title', 'content'],
      },
    },
  },
];

export function runTool(guildId, name, args) {
  if (name === 'kb_search') return search(guildId, String(args.query || ''));
  if (name === 'kb_list') return listEntries(guildId);
  if (name === 'kb_save') return save(guildId, String(args.title || ''), String(args.content || ''));
  return `Unknown knowledge base tool: ${name}`;
}
