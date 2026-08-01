"""Tools the AI can call while chatting: DuckDuckGo web search and GitHub
repo lookup. Exposed to OpenRouter via OpenAI-style function-calling schemas.
"""
import asyncio
import logging
import re
import time

import httpx

import config

log = logging.getLogger("tools")

# Matches github.com/<owner>/<repo> anywhere in a message or URL
GITHUB_URL_RE = re.compile(r"github\.com/([\w.-]+)/([\w.-]+)")

# First path segments on github.com that are not repo owners
NON_REPO_OWNERS = {
    "orgs", "topics", "search", "settings", "marketplace", "sponsors",
    "features", "about", "pricing", "collections", "trending", "login",
}

SEARCH_RESULTS = 5
README_MAX = 4000
TOOL_RESULT_MAX = 8000

TOOL_SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": (
                "Search the web with DuckDuckGo. Use this for current events, "
                "documentation, or anything you don't know or might be out of date on."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "The search query"},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "repo_tree",
            "description": (
                "List your own source repository's files with sizes and purposes "
                "(read-only; secrets, databases, and vendor dirs are excluded)."
            ),
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "repo_search",
            "description": "Regex-search your own source code. Returns file:line matches.",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "Regex to search for"},
                    "glob": {"type": "string", "description": "Optional path filter, e.g. bot/cogs/*.py"},
                },
                "required": ["pattern"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "repo_read",
            "description": "Read one of your own source files (optionally a line range).",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Repo-relative path"},
                    "start": {"type": "integer", "description": "First line (1-based)"},
                    "end": {"type": "integer", "description": "Last line"},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "repo_deps",
            "description": "List your own dependency manifests (python + node) with versions.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "github_branches",
            "description": (
                "List every branch on your own GitHub repo (not just the one "
                "checked out locally) — use this to see what contributors have "
                "pushed."
            ),
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "github_pull_requests",
            "description": "List pull requests on your own repo.",
            "parameters": {
                "type": "object",
                "properties": {
                    "state": {"type": "string", "enum": ["open", "closed", "all"],
                              "description": "Default open"},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "github_pull_request",
            "description": (
                "Full detail on one pull request: description, files changed, "
                "and the diff — for actually reviewing a contributor's change."
            ),
            "parameters": {
                "type": "object",
                "properties": {"number": {"type": "integer", "description": "PR number"}},
                "required": ["number"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "github_compare",
            "description": (
                "Diff between any two branches/refs on your own repo — use this "
                "to review a contributor's pushed branch even if they haven't "
                "opened a pull request yet."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "base": {"type": "string", "description": "Base branch/ref, e.g. main"},
                    "head": {"type": "string", "description": "Branch/ref to compare against base"},
                },
                "required": ["base", "head"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "github_commits",
            "description": "Recent commits on a branch of your own repo.",
            "parameters": {
                "type": "object",
                "properties": {
                    "ref": {"type": "string", "description": "Branch/ref, default main"},
                    "limit": {"type": "integer", "description": "Max commits, default 10"},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "github_file",
            "description": (
                "Read a file from your own repo at any branch/commit ref — not "
                "just the local checkout. Same secret exclusions as repo_read."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Repo-relative path"},
                    "ref": {"type": "string", "description": "Branch/commit/tag, default main"},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "github_repo",
            "description": (
                "Fetch details about a GitHub repository: description, stars, "
                "languages, topics, and README. Use when discussing a repo."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "repo": {
                        "type": "string",
                        "description": "The repository, as owner/name or a github.com URL",
                    },
                },
                "required": ["repo"],
            },
        },
    },
]


async def run_tool(name: str, arguments: dict) -> str:
    """Execute a tool call and return its result as text. Never raises —
    errors come back as text so the model can tell the user what happened."""
    try:
        if name == "web_search":
            return await web_search(str(arguments.get("query", "")))
        if name == "github_repo":
            return await github_repo(str(arguments.get("repo", "")))
        if name in ("repo_tree", "repo_search", "repo_read", "repo_deps"):
            import introspect
            if name == "repo_tree":
                return introspect.repo_tree()
            if name == "repo_search":
                return introspect.repo_search(str(arguments.get("pattern", "")),
                                              str(arguments.get("glob", "")))
            if name == "repo_read":
                return introspect.repo_read(
                    str(arguments.get("path", "")),
                    int(arguments.get("start", 1) or 1),
                    int(arguments["end"]) if arguments.get("end") else None)
            return introspect.repo_deps()
        if name.startswith("github_") and name != "github_repo":
            import github_api
            if name == "github_branches":
                return await github_api.list_branches()
            if name == "github_pull_requests":
                return await github_api.list_pull_requests(str(arguments.get("state", "open")))
            if name == "github_pull_request":
                return await github_api.get_pull_request(int(arguments.get("number", 0)))
            if name == "github_compare":
                return await github_api.compare_branches(
                    str(arguments.get("base", "main")), str(arguments.get("head", "")))
            if name == "github_commits":
                return await github_api.list_commits(
                    str(arguments.get("ref", "main")), int(arguments.get("limit", 10) or 10))
            if name == "github_file":
                return await github_api.read_file(
                    str(arguments.get("path", "")), str(arguments.get("ref", "main")))
        return f"Unknown tool: {name}"
    except Exception as exc:
        log.warning("Tool %s failed: %s", name, exc)
        return f"Tool {name} failed: {exc}"


# -- web search -------------------------------------------------------------

def _ddg_search(query: str, max_results: int) -> list[dict]:
    from ddgs import DDGS
    from ddgs.exceptions import DDGSException

    with DDGS() as ddgs:
        try:
            return list(ddgs.text(query, max_results=max_results, backend="duckduckgo"))
        except DDGSException:
            # DuckDuckGo itself unreachable/blocked — let ddgs rotate backends
            return list(ddgs.text(query, max_results=max_results, backend="auto"))


async def web_search(query: str, max_results: int = SEARCH_RESULTS) -> str:
    if not query:
        return "Empty search query."
    results = await asyncio.to_thread(_ddg_search, query, max_results)
    if not results:
        return "No results found."
    return "\n\n".join(
        f"{r.get('title', '')}\n{r.get('href', '')}\n{r.get('body', '')}"
        for r in results
    )[:TOOL_RESULT_MAX]


# -- GitHub -----------------------------------------------------------------

def find_repo_refs(text: str) -> list[tuple[str, str]]:
    """Extract unique (owner, repo) pairs from github.com links in text."""
    refs = []
    for owner, name in GITHUB_URL_RE.findall(text):
        name = name.removesuffix(".git")
        if owner.lower() in NON_REPO_OWNERS:
            continue
        if (owner, name) not in refs:
            refs.append((owner, name))
    return refs


# Auto-attach re-fetches every repo link found in every message, and the
# same repo commonly gets mentioned repeatedly across one conversation —
# without a cache that burns through GitHub's rate limit for no reason.
REPO_CACHE_TTL = 300  # seconds
_repo_cache: dict[str, tuple[float, str]] = {}


async def github_repo(ref: str) -> str:
    match = GITHUB_URL_RE.search(ref)
    if match:
        owner, name = match.group(1), match.group(2)
    elif ref.count("/") == 1:
        owner, name = ref.split("/")
    else:
        return f"Can't parse repository reference: {ref!r} (expected owner/name or a github.com URL)"
    name = name.removesuffix(".git")

    cache_key = f"{owner.lower()}/{name.lower()}"
    cached = _repo_cache.get(cache_key)
    if cached and time.monotonic() - cached[0] < REPO_CACHE_TTL:
        return cached[1]
    result = await _fetch_repo(owner, name)
    _repo_cache[cache_key] = (time.monotonic(), result)
    return result


async def _fetch_repo(owner: str, name: str) -> str:
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "discord-agent"}
    if config.GITHUB_TOKEN:
        headers["Authorization"] = f"Bearer {config.GITHUB_TOKEN}"
    async with httpx.AsyncClient(timeout=20, headers=headers, follow_redirects=True) as client:
        resp = await client.get(f"https://api.github.com/repos/{owner}/{name}")
        if resp.status_code == 404:
            return f"Repository {owner}/{name} not found (or it's private)."
        if resp.status_code == 403:
            return "GitHub API rate limit hit — try again in a bit."
        resp.raise_for_status()
        repo = resp.json()

        languages = {}
        try:
            lang_resp = await client.get(repo["languages_url"])
            if lang_resp.status_code == 200:
                languages = lang_resp.json()
        except httpx.HTTPError:
            pass

        readme = ""
        try:
            readme_resp = await client.get(
                f"https://api.github.com/repos/{owner}/{name}/readme",
                headers={"Accept": "application/vnd.github.raw+json"},
            )
            if readme_resp.status_code == 200:
                readme = readme_resp.text[:README_MAX]
        except httpx.HTTPError:
            pass

    total = sum(languages.values()) or 1
    lang_line = ", ".join(
        f"{lang} {100 * count / total:.0f}%" for lang, count in
        sorted(languages.items(), key=lambda kv: -kv[1])[:6]
    ) or "unknown"

    lines = [
        f"Repository: {repo['full_name']}",
        f"Description: {repo.get('description') or '(none)'}",
        f"Stars: {repo.get('stargazers_count', 0)} | Forks: {repo.get('forks_count', 0)} "
        f"| Open issues: {repo.get('open_issues_count', 0)}",
        f"Languages: {lang_line}",
        f"Topics: {', '.join(repo.get('topics', [])) or '(none)'}",
        f"License: {(repo.get('license') or {}).get('name') or '(none)'}",
        f"Created: {repo.get('created_at', '?')[:10]} | Last push: {repo.get('pushed_at', '?')[:10]}",
        f"Default branch: {repo.get('default_branch', 'main')}"
        + (" | ARCHIVED" if repo.get("archived") else ""),
    ]
    if repo.get("homepage"):
        lines.append(f"Homepage: {repo['homepage']}")
    if readme:
        lines.append(f"\nREADME (truncated):\n{readme}")
    return "\n".join(lines)[:TOOL_RESULT_MAX]
