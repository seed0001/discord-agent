"""Tools the AI agent can call to clone, install, run, edit, screenshot, and
push arbitrary git repos — inside a disposable E2B cloud sandbox, never on
the machine the bot itself runs on.

Owner-only, same enforcement pattern as agent_tools.py: ai.py only offers
these tools when the triggering message author is the bot owner, and
execute() re-checks before running anything. This starts out owner-only by
design (not a repo whitelist) — extending it to approved non-owner users
later just means changing that check.

One sandbox session is kept per Discord server (guild), not per channel —
a repo cloned from a text channel is immediately usable from voice, and
vice versa, since it's the same owner working the same project regardless
of which channel or modality they're using right now. A whole
clone -> install -> run -> screenshot -> edit -> push conversation can span
many tool calls, across text and voice, without re-cloning. The sandbox's
own idle timeout is refreshed on every call and tears it down automatically
if it goes quiet; sandbox_stop kills it immediately.
"""
import io
import json
import logging

import discord

import config
import tools
from bot.utils import is_owner

log = logging.getLogger("sandbox")

SANDBOX_TIMEOUT = 1800  # seconds; refreshed on every tool call (sliding idle window)
SHELL_DEFAULT_TIMEOUT = 60
SHELL_MAX_TIMEOUT = 600
OUTPUT_MAX = 6000

SHOT_SCRIPT_PATH = "/home/user/_max_shot.py"
SHOT_OUT_PATH = "/home/user/_max_shot.png"

# Retries navigation for a bit since a dev server may still be binding its
# port right after being started.
_SHOT_SCRIPT = """
import sys, time
from playwright.sync_api import sync_playwright

url, out, full_page = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
last_exc = None
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1280, "height": 800})
    for _ in range(6):
        try:
            page.goto(url, timeout=15000, wait_until="networkidle")
            last_exc = None
            break
        except Exception as exc:
            last_exc = exc
            time.sleep(3)
    if last_exc is not None:
        raise last_exc
    page.screenshot(path=out, full_page=full_page)
    browser.close()
"""


class ToolError(Exception):
    """Raised by handlers; the message is returned to the model as the result."""


class SandboxSession:
    def __init__(self, sandbox, owner: str, name: str, repo_dir: str, default_branch: str):
        self.sandbox = sandbox
        self.owner = owner
        self.name = name
        self.repo_dir = repo_dir
        self.default_branch = default_branch
        self.browser_ready = False


_sessions: dict[int, SandboxSession] = {}  # keyed by Discord guild id


def _cap(text) -> str:
    text = text or ""
    if len(text) > OUTPUT_MAX:
        return text[:OUTPUT_MAX] + f"\n... (truncated at {OUTPUT_MAX} chars)"
    return text


def _format_result(cmd: str, result) -> str:
    parts = [f"$ {cmd}", f"exit code: {result.exit_code}"]
    if result.stdout:
        parts.append(f"stdout:\n{_cap(result.stdout)}")
    if result.stderr:
        parts.append(f"stderr:\n{_cap(result.stderr)}")
    return "\n".join(parts)


async def _run(sandbox, cmd: str, **kwargs):
    """Run a shell command and always return an object with .exit_code/
    .stdout/.stderr, whether or not the SDK raises on a non-zero exit."""
    return await _call(sandbox.commands.run(cmd, **kwargs))


async def _call(coro):
    """Await any sandbox call (shell command or sandbox.git.* helper) and
    always return an object with .exit_code/.stdout/.stderr — the E2B SDK
    raises on failure (CommandExitException, GitAuthException, ...) rather
    than returning a failed result, so normalize both shapes here."""
    try:
        result = await coro
        if hasattr(result, "exit_code"):
            return result
        class _Ok:
            exit_code = 0
            stdout = str(result) if result is not None else ""
            stderr = ""
        return _Ok()
    except Exception as exc:
        class _Failed:
            exit_code = getattr(exc, "exit_code", 1)
            stdout = getattr(exc, "stdout", "") or ""
            stderr = getattr(exc, "stderr", "") or str(exc)
        return _Failed()


def _require_session(message: discord.Message) -> SandboxSession:
    session = _sessions.get(message.guild.id)
    if session is None:
        raise ToolError("No active sandbox for this server — clone a repo first with sandbox_clone.")
    return session


async def _touch(session: SandboxSession) -> None:
    try:
        await session.sandbox.set_timeout(SANDBOX_TIMEOUT)
    except Exception:
        pass


def _resolve_path(session: SandboxSession, path: str) -> str:
    path = path.strip()
    if path.startswith("/"):
        return path
    return f"{session.repo_dir}/{path.lstrip('/')}"


def _parse_repo(ref: str) -> tuple[str, str]:
    match = tools.GITHUB_URL_RE.search(ref)
    if match:
        owner, name = match.group(1), match.group(2)
    elif ref.count("/") == 1:
        owner, name = ref.split("/")
    else:
        raise ToolError(f"Can't parse repository reference: {ref!r} (expected owner/name or a github.com URL)")
    return owner, name.removesuffix(".git")


# -- tool implementations -----------------------------------------------

async def _sandbox_clone(bot, message, args):
    if not config.E2B_API_KEY:
        raise ToolError("E2B_API_KEY is not set — sandbox tools are unavailable.")
    owner, name = _parse_repo(str(args["repo"]).strip())
    branch = args.get("branch")

    old = _sessions.pop(message.guild.id, None)
    if old is not None:
        try:
            await old.sandbox.kill()
        except Exception:
            pass

    from e2b import AsyncSandbox
    sandbox = await AsyncSandbox.create(timeout=SANDBOX_TIMEOUT)

    repo_url = f"https://github.com/{owner}/{name}.git"
    repo_dir = f"/home/user/{name}"
    # Credentials are used only for this request, never left in the stored
    # remote URL (dangerously_store_credentials defaults False) — push later
    # passes the token again explicitly.
    auth = {"username": "x-access-token", "password": config.GITHUB_WRITE_TOKEN} \
        if config.GITHUB_WRITE_TOKEN else {}
    clone = await _call(sandbox.git.clone(
        repo_url, path=repo_dir, branch=branch, depth=1, timeout=120, **auth))
    if clone.exit_code != 0:
        await sandbox.kill()
        return f"Clone failed (exit {clone.exit_code}):\n{_cap(clone.stderr or clone.stdout)}"

    try:
        status = await sandbox.git.status(repo_dir)
        current_branch = status.current_branch or branch or "main"
    except Exception:
        current_branch = branch or "main"
    listing = await _run(sandbox, f"ls -la {repo_dir}")

    _sessions[message.guild.id] = SandboxSession(sandbox, owner, name, repo_dir, current_branch)
    return (
        f"Cloned {owner}/{name} (branch {current_branch}) into the sandbox at {repo_dir}.\n"
        f"Top-level contents:\n{_cap(listing.stdout)}"
    )


async def _sandbox_shell(bot, message, args):
    session = _require_session(message)
    await _touch(session)
    cmd = str(args["command"])
    cwd = args.get("cwd") or session.repo_dir
    background = bool(args.get("background", False))

    if background:
        handle = await session.sandbox.commands.run(cmd, background=True, cwd=cwd)
        pid = getattr(handle, "pid", "?")
        return f"Started in background (pid {pid}): {cmd}"

    timeout = min(int(args.get("timeout", SHELL_DEFAULT_TIMEOUT) or SHELL_DEFAULT_TIMEOUT), SHELL_MAX_TIMEOUT)
    result = await _run(session.sandbox, cmd, cwd=cwd, timeout=timeout)
    return _format_result(cmd, result)


async def _sandbox_read_file(bot, message, args):
    session = _require_session(message)
    await _touch(session)
    path = _resolve_path(session, str(args["path"]))
    try:
        content = await session.sandbox.files.read(path)
    except Exception as exc:
        return f"Failed to read {path}: {exc}"
    return f"{path} ({len(content)} chars):\n{_cap(content)}"


async def _sandbox_write_file(bot, message, args):
    session = _require_session(message)
    await _touch(session)
    path = _resolve_path(session, str(args["path"]))
    content = args.get("content", "")
    await session.sandbox.files.write(path, content)
    return f"Wrote {len(content)} chars to {path}."


async def _ensure_browser(session: SandboxSession):
    if session.browser_ready:
        return None
    install = await _run(
        session.sandbox,
        "python3 -m pip install --quiet playwright "
        "&& python3 -m playwright install --with-deps chromium",
        timeout=240,
    )
    if install.exit_code != 0:
        return (f"Failed to set up the browser for screenshots (exit {install.exit_code}):\n"
                f"{_cap(install.stderr or install.stdout)}")
    session.browser_ready = True
    return None


async def _sandbox_screenshot(bot, message, args):
    session = _require_session(message)
    await _touch(session)
    url = str(args["url"]).strip()
    full_page = bool(args.get("full_page", False))

    setup_error = await _ensure_browser(session)
    if setup_error:
        return setup_error

    await session.sandbox.files.write(SHOT_SCRIPT_PATH, _SHOT_SCRIPT)
    result = await _run(
        session.sandbox,
        f'python3 {SHOT_SCRIPT_PATH} "{url}" {SHOT_OUT_PATH} {"1" if full_page else "0"}',
        timeout=120,
    )
    if result.exit_code != 0:
        return (f"Screenshot failed (exit {result.exit_code}) — is anything actually listening "
                f"on {url} yet?\n{_cap(result.stderr or result.stdout)}")

    try:
        data = await session.sandbox.files.read(SHOT_OUT_PATH, format="bytes")
    except Exception as exc:
        return f"Screenshot ran but couldn't be read back: {exc}"

    await message.channel.send(content=url, file=discord.File(io.BytesIO(data), filename="screenshot.png"))
    return f"Posted a screenshot of {url} to the channel."


async def _sandbox_push(bot, message, args):
    session = _require_session(message)
    await _touch(session)
    if not config.GITHUB_WRITE_TOKEN:
        raise ToolError("GITHUB_WRITE_TOKEN is not set — I can't push anywhere.")
    commit_message = str(args.get("message") or "Update via Max").strip()
    branch = str(args.get("branch") or session.default_branch).strip()

    await _call(session.sandbox.git.add(session.repo_dir))
    commit = await _call(session.sandbox.git.commit(
        session.repo_dir, commit_message, author_name="Max", author_email="max@bot.local"))
    if commit.exit_code != 0 and "nothing to commit" not in (commit.stdout + commit.stderr).lower():
        return f"Commit failed (exit {commit.exit_code}):\n{_cap(commit.stderr or commit.stdout)}"

    if branch != session.default_branch:
        # Switch to the target branch: check it out if it already exists
        # locally, otherwise create it.
        checkout = await _call(session.sandbox.git.checkout_branch(session.repo_dir, branch))
        if checkout.exit_code != 0:
            checkout = await _call(session.sandbox.git.create_branch(session.repo_dir, branch))
            if checkout.exit_code != 0:
                return (f"Couldn't switch to branch {branch} (exit {checkout.exit_code}):\n"
                        f"{_cap(checkout.stderr or checkout.stdout)}")

    auth = {"username": "x-access-token", "password": config.GITHUB_WRITE_TOKEN} \
        if config.GITHUB_WRITE_TOKEN else {}
    push = await _call(session.sandbox.git.push(
        session.repo_dir, remote="origin", branch=branch, timeout=90, **auth))
    if push.exit_code != 0:
        return f"Push failed (exit {push.exit_code}):\n{_cap(push.stderr or push.stdout)}"

    return (f"Pushed to {session.owner}/{session.name}@{branch}.\n"
            f"https://github.com/{session.owner}/{session.name}/commits/{branch}")


async def _sandbox_stop(bot, message, args):
    session = _sessions.pop(message.guild.id, None)
    if session is None:
        return "No active sandbox for this server."
    try:
        await session.sandbox.kill()
    except Exception as exc:
        return f"Sandbox removed from tracking, but kill may have failed: {exc}"
    return f"Sandbox for {session.owner}/{session.name} stopped."


# -- registry -------------------------------------------------------------

def _str(desc: str) -> dict:
    return {"type": "string", "description": desc}


def _int(desc: str) -> dict:
    return {"type": "integer", "description": desc}


def _schema(name: str, description: str, params: dict | None = None,
            required: list[str] | None = None) -> dict:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": params or {},
                "required": required or [],
            },
        },
    }


TOOLS: dict[str, tuple[dict, callable]] = {
    "sandbox_clone": (_schema(
        "sandbox_clone",
        "Clone a GitHub repo into a fresh, disposable cloud sandbox (not the "
        "machine you run on) so it can be installed, run, edited, and pushed. "
        "Only clone/run someone's code after the owner has explicitly told "
        "you to — ask first and wait for a clear yes. Replaces any sandbox "
        "already active for this server (shared across text and voice — "
        "there's one active project at a time, not one per channel).",
        {"repo": _str("Repository as owner/name or a github.com URL"),
         "branch": _str("Branch to check out (optional, defaults to the repo's default branch)")},
        ["repo"]), _sandbox_clone),
    "sandbox_shell": (_schema(
        "sandbox_shell",
        "Run a shell command in the active sandbox (installs, builds, starts "
        "servers, git, anything). Runs in the cloned repo's directory unless "
        "cwd is given. Use background=true for long-running processes like "
        "dev servers so the call returns immediately instead of hanging.",
        {"command": _str("Shell command to run"),
         "cwd": _str("Working directory (optional, defaults to the repo root)"),
         "background": {"type": "boolean",
                        "description": "Run detached and return immediately (default false)"},
         "timeout": _int(f"Seconds to wait for a foreground command "
                         f"(default {SHELL_DEFAULT_TIMEOUT}, max {SHELL_MAX_TIMEOUT})")},
        ["command"]), _sandbox_shell),
    "sandbox_read_file": (_schema(
        "sandbox_read_file", "Read a file's contents from the active sandbox's cloned repo.",
        {"path": _str("Path, relative to the repo root unless it starts with /")}, ["path"]),
        _sandbox_read_file),
    "sandbox_write_file": (_schema(
        "sandbox_write_file",
        "Create or overwrite a file in the active sandbox's cloned repo with "
        "the given content — this is how you make edits.",
        {"path": _str("Path, relative to the repo root unless it starts with /"),
         "content": _str("Full new content of the file")}, ["path", "content"]),
        _sandbox_write_file),
    "sandbox_screenshot": (_schema(
        "sandbox_screenshot",
        "Load a URL (e.g. the dev server you just started) in a headless "
        "browser inside the sandbox and post a screenshot directly to this "
        "channel. The first call installs a browser in the sandbox, which "
        "takes a bit longer.",
        {"url": _str("Full URL, e.g. http://localhost:3000"),
         "full_page": {"type": "boolean",
                       "description": "Capture the full scrollable page, not just the "
                                      "viewport (default false)"}},
        ["url"]), _sandbox_screenshot),
    "sandbox_push": (_schema(
        "sandbox_push",
        "Commit all changes in the active sandbox's repo and push to GitHub. "
        "Only do this when the owner has told you to push.",
        {"message": _str("Commit message"),
         "branch": _str("Branch to push to (optional, defaults to the branch that was checked out)")},
        ["message"]), _sandbox_push),
    "sandbox_stop": (_schema(
        "sandbox_stop", "Tear down the active sandbox for this server to stop billing for it."),
        _sandbox_stop),
}

TOOL_SCHEMAS = [entry[0] for entry in TOOLS.values()]


async def execute(bot, message: discord.Message, name: str, arguments) -> str:
    """Run one tool call and return its result string (never raises)."""
    if not is_owner(message.author.id):
        return "Error: only the bot owner can use sandbox tools."
    entry = TOOLS.get(name)
    if entry is None:
        return f"Error: unknown tool '{name}'."
    try:
        args = json.loads(arguments) if isinstance(arguments, str) else (arguments or {})
        if not isinstance(args, dict):
            raise ToolError("Tool arguments must be an object.")
    except json.JSONDecodeError:
        return "Error: tool arguments were not valid JSON."
    try:
        return await entry[1](bot, message, args)
    except ToolError as exc:
        return f"Error: {exc}"
    except (KeyError, TypeError, ValueError) as exc:
        return f"Error: bad or missing tool arguments ({exc})."
    except discord.HTTPException as exc:
        return f"Error: Discord API error: {exc}"
    except Exception as exc:
        log.exception("sandbox tool %s failed", name)
        return f"Error: {exc}"
