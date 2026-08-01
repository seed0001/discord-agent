"""Read-only GitHub API access to Max's own repository: branches, pull
requests, diffs, commits, and file contents at any ref.

Distinct from introspect.py, which only sees the local checked-out working
tree — this reaches GitHub directly, so Max can see contributor branches
and pull requests that were never checked out locally at all. That's the
whole point: full visibility into what contributors have pushed, for
review and discussion, before anything is decided.

Hard rule enforced in code, not by the model: read-only. There is no
create/update/delete/merge call anywhere in this module — that stays true
here no matter what else the bot can do elsewhere.

(Max does have a separate, owner-only write path now: bot/sandbox_tools.py
clones/runs/edits/pushes repos the owner explicitly hands him, inside a
disposable cloud sandbox. That's a distinct mechanism from this module and
never touches this repo's read-only introspection tools.)

The same secret exclusion and redaction rules as the local repo tools
apply here too: file reads refuse known-sensitive paths, and all textual
output is redacted for configured secrets and common credential shapes
before it's returned.
"""
from __future__ import annotations

import base64
import fnmatch

import httpx

import config
import introspect

API = "https://api.github.com"
RESULT_MAX = 8000
DIFF_MAX = 12000
MAX_LIST = 30

UNTRUSTED_NOTE = introspect.UNTRUSTED_NOTE


def _repo() -> str:
    return config.GITHUB_REPO


def _headers(accept: str = "application/vnd.github+json") -> dict:
    headers = {"Accept": accept, "User-Agent": "discord-agent"}
    if config.GITHUB_TOKEN:
        headers["Authorization"] = f"Bearer {config.GITHUB_TOKEN}"
    return headers


def _cap(text: str, limit: int = RESULT_MAX) -> str:
    text = introspect._redact(text)
    if len(text) > limit:
        return text[:limit] + f"\n... (truncated at {limit} chars)"
    return text


async def _get(path: str, accept: str = "application/vnd.github+json",
               params: dict | None = None) -> httpx.Response:
    url = f"{API}/repos/{_repo()}{path}"
    async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
        return await client.get(url, headers=_headers(accept), params=params)


def _err(resp: httpx.Response, what: str) -> str:
    if resp.status_code == 404:
        return f"{what} not found on {_repo()}."
    if resp.status_code == 403:
        return "GitHub API rate limit hit — try again in a bit."
    return f"GitHub API error {resp.status_code} fetching {what}: {resp.text[:200]}"


# -- branches -----------------------------------------------------------

async def list_branches() -> str:
    resp = await _get("/branches", params={"per_page": 100})
    if resp.status_code != 200:
        return _err(resp, "branches")
    branches = resp.json()
    lines = [f"Branches on {_repo()} ({len(branches)}):"]
    for b in branches:
        protected = " [protected]" if b.get("protected") else ""
        sha = (b.get("commit") or {}).get("sha", "")[:7]
        lines.append(f"- {b['name']} ({sha}){protected}")
    return _cap("\n".join(lines))


# -- pull requests --------------------------------------------------------

async def list_pull_requests(state: str = "open") -> str:
    state = state if state in ("open", "closed", "all") else "open"
    resp = await _get("/pulls", params={"state": state, "per_page": MAX_LIST,
                                        "sort": "updated", "direction": "desc"})
    if resp.status_code != 200:
        return _err(resp, "pull requests")
    prs = resp.json()
    if not prs:
        return f"No {state} pull requests on {_repo()}."
    lines = [f"{state.title()} pull requests on {_repo()} ({len(prs)}):"]
    for pr in prs:
        lines.append(
            f"- #{pr['number']} {pr['title']!r} by {pr['user']['login']} — "
            f"{pr['head']['ref']} -> {pr['base']['ref']} "
            f"({pr['state']}{', draft' if pr.get('draft') else ''}), "
            f"updated {pr['updated_at'][:10]}")
    return _cap("\n".join(lines))


async def get_pull_request(number: int) -> str:
    resp = await _get(f"/pulls/{number}")
    if resp.status_code != 200:
        return _err(resp, f"PR #{number}")
    pr = resp.json()

    files_resp = await _get(f"/pulls/{number}/files", params={"per_page": 100})
    files = files_resp.json() if files_resp.status_code == 200 else []
    file_lines = [
        f"  {f['status']}: {f['filename']} (+{f['additions']}/-{f['deletions']})"
        for f in files[:50]
    ]
    if len(files) > 50:
        file_lines.append(f"  ... and {len(files) - 50} more file(s)")

    diff_resp = await _get(f"/pulls/{number}", accept="application/vnd.github.v3.diff")
    diff = diff_resp.text if diff_resp.status_code == 200 else "(diff unavailable)"

    summary = [
        f"PR #{pr['number']}: {pr['title']}",
        f"Author: {pr['user']['login']} | State: {pr['state']}"
        f"{' (draft)' if pr.get('draft') else ''}",
        f"Branch: {pr['head']['ref']} -> {pr['base']['ref']}",
        f"Mergeable: {pr.get('mergeable')} ({pr.get('mergeable_state', '?')}) "
        f"| Commits: {pr.get('commits', '?')} "
        f"| Changed files: {pr.get('changed_files', len(files))} "
        f"(+{pr.get('additions', '?')}/-{pr.get('deletions', '?')})",
        f"Created: {pr['created_at'][:10]} | Updated: {pr['updated_at'][:10]}",
    ]
    if pr.get("body"):
        summary.append(f"\nDescription:\n{pr['body'][:1000]}")
    summary.append("\nFiles changed:\n" + "\n".join(file_lines))
    summary.append(f"\nDiff (may be truncated):\n{diff[:DIFF_MAX]}")
    if len(diff) > DIFF_MAX:
        summary.append(f"... (diff truncated at {DIFF_MAX} chars — use github_file "
                       "for full file contents, or github_compare for a narrower range)")
    return UNTRUSTED_NOTE + _cap("\n".join(summary), limit=RESULT_MAX + DIFF_MAX)


# -- branch comparison (covers pushed branches with no PR open yet) -------

async def compare_branches(base: str, head: str) -> str:
    resp = await _get(f"/compare/{base}...{head}")
    if resp.status_code != 200:
        return _err(resp, f"comparison {base}...{head}")
    data = resp.json()
    lines = [
        f"Comparing {base}...{head} on {_repo()}: {data.get('status', '?')}, "
        f"{data.get('ahead_by', 0)} ahead, {data.get('behind_by', 0)} behind, "
        f"{data.get('total_commits', 0)} commit(s)",
    ]
    for c in (data.get("commits") or [])[-20:]:
        msg = c["commit"]["message"].splitlines()[0]
        author = (c.get("author") or {}).get("login", c["commit"]["author"]["name"])
        lines.append(f"- {c['sha'][:7]} {author}: {msg}")
    files = data.get("files") or []
    if files:
        lines.append(f"\nFiles changed ({len(files)}):")
        for f in files[:50]:
            lines.append(f"  {f['status']}: {f['filename']} (+{f['additions']}/-{f['deletions']})")

    diff_resp = await _get(f"/compare/{base}...{head}", accept="application/vnd.github.v3.diff")
    if diff_resp.status_code == 200:
        diff = diff_resp.text
        lines.append(f"\nDiff (may be truncated):\n{diff[:DIFF_MAX]}")
        if len(diff) > DIFF_MAX:
            lines.append(f"... (diff truncated at {DIFF_MAX} chars)")
    return UNTRUSTED_NOTE + _cap("\n".join(lines), limit=RESULT_MAX + DIFF_MAX)


# -- commits ----------------------------------------------------------------

async def list_commits(ref: str = "main", limit: int = 10) -> str:
    limit = max(1, min(limit, 30))
    resp = await _get("/commits", params={"sha": ref, "per_page": limit})
    if resp.status_code != 200:
        return _err(resp, f"commits on {ref!r}")
    commits = resp.json()
    lines = [f"Recent commits on {ref!r} ({len(commits)}):"]
    for c in commits:
        msg = c["commit"]["message"].splitlines()[0]
        author = (c.get("author") or {}).get("login", c["commit"]["author"]["name"])
        lines.append(f"- {c['sha'][:7]} {author} ({c['commit']['author']['date'][:10]}): {msg}")
    return _cap("\n".join(lines))


# -- file contents at any ref ------------------------------------------------

async def read_file(path: str, ref: str = "main") -> str:
    if any(fnmatch.fnmatch(path.rsplit("/", 1)[-1], pat) for pat in introspect.EXCLUDE_FILE_PATTERNS):
        return f"'{path}' is excluded (secrets/data/generated files are off-limits), even from GitHub."
    resp = await _get(f"/contents/{path.lstrip('/')}", params={"ref": ref})
    if resp.status_code != 200:
        return _err(resp, f"{path!r} at {ref!r}")
    data = resp.json()
    if isinstance(data, list):
        names = ", ".join(item["name"] for item in data[:50])
        return f"'{path}' is a directory at {ref!r}, not a file. Contents: {names}"
    if data.get("encoding") != "base64":
        return f"Unexpected encoding for {path!r}: {data.get('encoding')}"
    try:
        content = base64.b64decode(data["content"]).decode(errors="replace")
    except Exception as exc:
        return f"Failed to decode {path!r}: {exc}"
    header = f"{path} @ {ref} ({data.get('size', len(content))} bytes)\n"
    return UNTRUSTED_NOTE + header + _cap(content)
