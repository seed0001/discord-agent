"""Tools the AI can call while chatting: DuckDuckGo web search and GitHub
repo lookup. Exposed to OpenRouter via OpenAI-style function-calling schemas.
"""
import asyncio
import logging
import re

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


async def github_repo(ref: str) -> str:
    match = GITHUB_URL_RE.search(ref)
    if match:
        owner, name = match.group(1), match.group(2)
    elif ref.count("/") == 1:
        owner, name = ref.split("/")
    else:
        return f"Can't parse repository reference: {ref!r} (expected owner/name or a github.com URL)"
    name = name.removesuffix(".git")

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
