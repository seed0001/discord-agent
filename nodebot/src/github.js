// GitHub access — Max's own repository (branches, PRs, diffs, commits,
// files at any ref) plus public repo lookup for links dropped in chat.
// Ported from github_api.py and the GitHub half of tools.py.
//
// Hard rule enforced in code, not by the model: read-only. There is no
// create/update/delete/merge call anywhere in this module.
//
// The same secret exclusion and redaction rules as the local repo tools
// apply: file reads refuse known-sensitive paths, and all textual output is
// redacted for configured secrets and common credential shapes before it is
// returned.
import { GITHUB_TOKEN, GITHUB_REPO } from './config.js';
import { redact, globMatch, EXCLUDE_FILE_PATTERNS, UNTRUSTED_NOTE } from './introspect.js';

const API = 'https://api.github.com';
const RESULT_MAX = 8000;
const DIFF_MAX = 12000;
const MAX_LIST = 30;
const README_MAX = 4000;

// Matches github.com/<owner>/<repo> anywhere in a message or URL.
const GITHUB_URL_RE = /github\.com\/([\w.-]+)\/([\w.-]+)/g;

// First path segments on github.com that are not repo owners.
const NON_REPO_OWNERS = new Set([
  'orgs', 'topics', 'search', 'settings', 'marketplace', 'sponsors',
  'features', 'about', 'pricing', 'collections', 'trending', 'login',
]);

function headers(accept = 'application/vnd.github+json') {
  const out = { Accept: accept, 'User-Agent': 'discord-agent' };
  if (GITHUB_TOKEN) out.Authorization = `Bearer ${GITHUB_TOKEN}`;
  return out;
}

function cap(text, limit = RESULT_MAX) {
  const redacted = redact(text);
  return redacted.length > limit
    ? `${redacted.slice(0, limit)}\n... (truncated at ${limit} chars)`
    : redacted;
}

async function api(path, { accept = 'application/vnd.github+json', params } = {}) {
  const url = new URL(`${API}/repos/${GITHUB_REPO}${path}`);
  for (const [key, value] of Object.entries(params || {})) {
    url.searchParams.set(key, String(value));
  }
  return fetch(url, { headers: headers(accept) });
}

function errorFor(resp, what) {
  if (resp.status === 404) return `${what} not found on ${GITHUB_REPO}.`;
  if (resp.status === 403) return 'GitHub API rate limit hit — try again in a bit.';
  return `GitHub API error ${resp.status} fetching ${what}.`;
}

// -- branches ---------------------------------------------------------------

export async function listBranches() {
  const resp = await api('/branches', { params: { per_page: 100 } });
  if (!resp.ok) return errorFor(resp, 'branches');
  const branches = await resp.json();
  const lines = [`Branches on ${GITHUB_REPO} (${branches.length}):`];
  for (const b of branches) {
    const protectedTag = b.protected ? ' [protected]' : '';
    lines.push(`- ${b.name} (${(b.commit?.sha || '').slice(0, 7)})${protectedTag}`);
  }
  return cap(lines.join('\n'));
}

// -- pull requests ----------------------------------------------------------

export async function listPullRequests(state = 'open') {
  const wanted = ['open', 'closed', 'all'].includes(state) ? state : 'open';
  const resp = await api('/pulls', {
    params: { state: wanted, per_page: MAX_LIST, sort: 'updated', direction: 'desc' },
  });
  if (!resp.ok) return errorFor(resp, 'pull requests');
  const prs = await resp.json();
  if (!prs.length) return `No ${wanted} pull requests on ${GITHUB_REPO}.`;
  const title = wanted.charAt(0).toUpperCase() + wanted.slice(1);
  const lines = [`${title} pull requests on ${GITHUB_REPO} (${prs.length}):`];
  for (const pr of prs) {
    lines.push(`- #${pr.number} '${pr.title}' by ${pr.user.login} — `
      + `${pr.head.ref} -> ${pr.base.ref} (${pr.state}${pr.draft ? ', draft' : ''}), `
      + `updated ${pr.updated_at.slice(0, 10)}`);
  }
  return cap(lines.join('\n'));
}

export async function getPullRequest(number) {
  const resp = await api(`/pulls/${number}`);
  if (!resp.ok) return errorFor(resp, `PR #${number}`);
  const pr = await resp.json();

  const filesResp = await api(`/pulls/${number}/files`, { params: { per_page: 100 } });
  const files = filesResp.ok ? await filesResp.json() : [];
  const fileLines = files.slice(0, 50).map(
    (f) => `  ${f.status}: ${f.filename} (+${f.additions}/-${f.deletions})`,
  );
  if (files.length > 50) fileLines.push(`  ... and ${files.length - 50} more file(s)`);

  const diffResp = await api(`/pulls/${number}`, { accept: 'application/vnd.github.v3.diff' });
  const diff = diffResp.ok ? await diffResp.text() : '(diff unavailable)';

  const summary = [
    `PR #${pr.number}: ${pr.title}`,
    `Author: ${pr.user.login} | State: ${pr.state}${pr.draft ? ' (draft)' : ''}`,
    `Branch: ${pr.head.ref} -> ${pr.base.ref}`,
    `Mergeable: ${pr.mergeable} (${pr.mergeable_state ?? '?'}) | Commits: ${pr.commits ?? '?'} `
      + `| Changed files: ${pr.changed_files ?? files.length} `
      + `(+${pr.additions ?? '?'}/-${pr.deletions ?? '?'})`,
    `Created: ${pr.created_at.slice(0, 10)} | Updated: ${pr.updated_at.slice(0, 10)}`,
  ];
  if (pr.body) summary.push(`\nDescription:\n${pr.body.slice(0, 1000)}`);
  summary.push(`\nFiles changed:\n${fileLines.join('\n')}`);
  summary.push(`\nDiff (may be truncated):\n${diff.slice(0, DIFF_MAX)}`);
  if (diff.length > DIFF_MAX) {
    summary.push(`... (diff truncated at ${DIFF_MAX} chars — use github_file for full file `
      + 'contents, or github_compare for a narrower range)');
  }
  return UNTRUSTED_NOTE + cap(summary.join('\n'), RESULT_MAX + DIFF_MAX);
}

// -- branch comparison (covers pushed branches with no PR open yet) ---------

export async function compareBranches(base, head) {
  const resp = await api(`/compare/${base}...${head}`);
  if (!resp.ok) return errorFor(resp, `comparison ${base}...${head}`);
  const data = await resp.json();
  const lines = [
    `Comparing ${base}...${head} on ${GITHUB_REPO}: ${data.status ?? '?'}, `
    + `${data.ahead_by ?? 0} ahead, ${data.behind_by ?? 0} behind, `
    + `${data.total_commits ?? 0} commit(s)`,
  ];
  for (const c of (data.commits || []).slice(-20)) {
    const message = c.commit.message.split('\n')[0];
    lines.push(`- ${c.sha.slice(0, 7)} ${c.author?.login || c.commit.author.name}: ${message}`);
  }
  const files = data.files || [];
  if (files.length) {
    lines.push(`\nFiles changed (${files.length}):`);
    for (const f of files.slice(0, 50)) {
      lines.push(`  ${f.status}: ${f.filename} (+${f.additions}/-${f.deletions})`);
    }
  }
  const diffResp = await api(`/compare/${base}...${head}`, { accept: 'application/vnd.github.v3.diff' });
  if (diffResp.ok) {
    const diff = await diffResp.text();
    lines.push(`\nDiff (may be truncated):\n${diff.slice(0, DIFF_MAX)}`);
    if (diff.length > DIFF_MAX) lines.push(`... (diff truncated at ${DIFF_MAX} chars)`);
  }
  return UNTRUSTED_NOTE + cap(lines.join('\n'), RESULT_MAX + DIFF_MAX);
}

// -- commits ----------------------------------------------------------------

export async function listCommits(ref = 'main', limit = 10) {
  const capped = Math.max(1, Math.min(parseInt(limit, 10) || 10, 30));
  const resp = await api('/commits', { params: { sha: ref, per_page: capped } });
  if (!resp.ok) return errorFor(resp, `commits on '${ref}'`);
  const commits = await resp.json();
  const lines = [`Recent commits on '${ref}' (${commits.length}):`];
  for (const c of commits) {
    const message = c.commit.message.split('\n')[0];
    const author = c.author?.login || c.commit.author.name;
    lines.push(`- ${c.sha.slice(0, 7)} ${author} (${c.commit.author.date.slice(0, 10)}): ${message}`);
  }
  return cap(lines.join('\n'));
}

// -- file contents at any ref -----------------------------------------------

export async function readFile(filePath, ref = 'main') {
  const basename = filePath.split('/').pop();
  if (EXCLUDE_FILE_PATTERNS.some((pattern) => globMatch(basename, pattern))) {
    return `'${filePath}' is excluded (secrets/data/generated files are off-limits), even from GitHub.`;
  }
  const resp = await api(`/contents/${filePath.replace(/^\/+/, '')}`, { params: { ref } });
  if (!resp.ok) return errorFor(resp, `'${filePath}' at '${ref}'`);
  const data = await resp.json();
  if (Array.isArray(data)) {
    const names = data.slice(0, 50).map((item) => item.name).join(', ');
    return `'${filePath}' is a directory at '${ref}', not a file. Contents: ${names}`;
  }
  if (data.encoding !== 'base64') return `Unexpected encoding for '${filePath}': ${data.encoding}`;
  let content;
  try {
    content = Buffer.from(data.content, 'base64').toString('utf8');
  } catch (err) {
    return `Failed to decode '${filePath}': ${err.message}`;
  }
  const header = `${filePath} @ ${ref} (${data.size ?? content.length} bytes)\n`;
  return UNTRUSTED_NOTE + header + cap(content);
}

// -- public repo lookup (for links dropped in chat) -------------------------

/** Unique [owner, repo] pairs from github.com links in text. */
export function findRepoRefs(text) {
  const refs = [];
  for (const match of String(text).matchAll(GITHUB_URL_RE)) {
    const owner = match[1];
    const name = match[2].replace(/\.git$/, '');
    if (NON_REPO_OWNERS.has(owner.toLowerCase())) continue;
    if (!refs.some(([o, n]) => o === owner && n === name)) refs.push([owner, name]);
  }
  return refs;
}

// Auto-attach re-fetches every repo link found in every message, and the
// same repo commonly gets mentioned repeatedly across one conversation —
// without a cache that burns through GitHub's rate limit for no reason.
const REPO_CACHE_TTL_MS = 300_000;
const repoCache = new Map();

export async function githubRepo(ref) {
  const match = new RegExp(GITHUB_URL_RE.source).exec(String(ref));
  let owner;
  let name;
  if (match) {
    [, owner, name] = match;
  } else if ((String(ref).match(/\//g) || []).length === 1) {
    [owner, name] = String(ref).split('/');
  } else {
    return `Can't parse repository reference: '${ref}' (expected owner/name or a github.com URL)`;
  }
  name = name.replace(/\.git$/, '');

  const cacheKey = `${owner.toLowerCase()}/${name.toLowerCase()}`;
  const cached = repoCache.get(cacheKey);
  if (cached && Date.now() - cached.at < REPO_CACHE_TTL_MS) return cached.result;
  const result = await fetchRepo(owner, name);
  repoCache.set(cacheKey, { at: Date.now(), result });
  return result;
}

async function fetchRepo(owner, name) {
  const resp = await fetch(`${API}/repos/${owner}/${name}`, { headers: headers() });
  if (resp.status === 404) return `Repository ${owner}/${name} not found (or it's private).`;
  if (resp.status === 403) return 'GitHub API rate limit hit — try again in a bit.';
  if (!resp.ok) return `GitHub API error ${resp.status} looking up ${owner}/${name}.`;
  const repo = await resp.json();

  let languages = {};
  try {
    const langResp = await fetch(repo.languages_url, { headers: headers() });
    if (langResp.ok) languages = await langResp.json();
  } catch { /* language breakdown is a nicety, not worth failing over */ }

  let readme = '';
  try {
    const readmeResp = await fetch(`${API}/repos/${owner}/${name}/readme`, {
      headers: headers('application/vnd.github.raw+json'),
    });
    if (readmeResp.ok) readme = (await readmeResp.text()).slice(0, README_MAX);
  } catch { /* same — a missing README is not an error */ }

  const total = Object.values(languages).reduce((a, b) => a + b, 0) || 1;
  const langLine = Object.entries(languages)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([lang, count]) => `${lang} ${Math.round((100 * count) / total)}%`)
    .join(', ') || 'unknown';

  const lines = [
    `Repository: ${repo.full_name}`,
    `Description: ${repo.description || '(none)'}`,
    `Stars: ${repo.stargazers_count ?? 0} | Forks: ${repo.forks_count ?? 0} `
      + `| Open issues: ${repo.open_issues_count ?? 0}`,
    `Languages: ${langLine}`,
    `Topics: ${(repo.topics || []).join(', ') || '(none)'}`,
    `License: ${repo.license?.name || '(none)'}`,
    `Created: ${(repo.created_at || '?').slice(0, 10)} | Last push: ${(repo.pushed_at || '?').slice(0, 10)}`,
    `Default branch: ${repo.default_branch || 'main'}${repo.archived ? ' | ARCHIVED' : ''}`,
  ];
  if (repo.homepage) lines.push(`Homepage: ${repo.homepage}`);
  if (readme) lines.push(`\nREADME (truncated):\n${readme}`);
  return cap(lines.join('\n'));
}

/** Test seam: drop the repo lookup cache. */
export function _clearCache() {
  repoCache.clear();
}

// -- tool surface -----------------------------------------------------------

export const GITHUB_TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'github_branches',
      description: 'List all branches on your own repository, including ones contributors '
        + 'pushed that were never checked out locally.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_pull_requests',
      description: 'List pull requests on your own repository.',
      parameters: {
        type: 'object',
        properties: {
          state: { type: 'string', description: 'open (default), closed, or all' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_pull_request',
      description: 'Full detail on one pull request: metadata, changed files, and the diff.',
      parameters: {
        type: 'object',
        properties: { number: { type: 'integer', description: 'The PR number' } },
        required: ['number'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_compare',
      description: 'Compare two branches or refs — commits and diff. Use this to review a '
        + 'pushed branch that has no pull request open yet.',
      parameters: {
        type: 'object',
        properties: {
          base: { type: 'string', description: 'Base ref, e.g. main' },
          head: { type: 'string', description: 'Head ref to compare against the base' },
        },
        required: ['base', 'head'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_commits',
      description: 'Recent commits on a branch or ref of your own repository.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Branch or ref (default main)' },
          limit: { type: 'integer', description: 'How many commits (default 10, max 30)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_file',
      description: 'Read a file from your own repository at any ref — including a '
        + "contributor's branch that isn't checked out locally.",
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Repo-relative file path' },
          ref: { type: 'string', description: 'Branch, tag, or commit (default main)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_repo',
      description: 'Look up any public GitHub repository: description, languages, '
        + 'activity, and README.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'The repository, as owner/name or a github.com URL' },
        },
        required: ['repo'],
      },
    },
  },
];

export async function runGithubTool(name, args = {}) {
  if (name === 'github_repo') return githubRepo(String(args.repo || ''));
  if (name === 'github_branches') return listBranches();
  if (name === 'github_pull_requests') return listPullRequests(String(args.state || 'open'));
  if (name === 'github_pull_request') return getPullRequest(parseInt(args.number, 10) || 0);
  if (name === 'github_compare') {
    return compareBranches(String(args.base || 'main'), String(args.head || ''));
  }
  if (name === 'github_commits') return listCommits(String(args.ref || 'main'), args.limit);
  if (name === 'github_file') return readFile(String(args.path || ''), String(args.ref || 'main'));
  return `unknown GitHub tool: ${name}`;
}
