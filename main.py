"""Entry point: runs the Discord bot, the dashboard web server, and the Node
voice listener sidecar in one process tree.

The sidecar is spawned as a subprocess with its output piped into python
logging, so its lines land in the dashboard log buffer alongside everything
else — and it gets restarted automatically if it dies. A liveness watchdog
force-exits the whole process (non-zero, so the platform restarts it) if the
Discord gateway stays dead for several minutes.
"""
import asyncio
import logging
import os
import time

import uvicorn

import config
import db
import logbuffer
from bot.client import bot
from web.app import create_app

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logbuffer.install()
log = logging.getLogger("main")

SIDECAR_BACKOFF_MAX = 60
GATEWAY_DEAD_AFTER = 300   # seconds of dead gateway before forced restart
HEARTBEAT_EVERY = 300


async def run_sidecar():
    """Run the Node voice listener, piping its output into our logs and
    restarting it with backoff if it exits."""
    slog = logging.getLogger("listener")
    backoff = 5
    while True:
        started = time.monotonic()
        try:
            proc = await asyncio.create_subprocess_exec(
                "node", "listener/index.js",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
        except FileNotFoundError:
            slog.error("node not found — voice listener disabled")
            return
        slog.info("sidecar started (pid %s)", proc.pid)
        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            text = line.decode(errors="replace").rstrip()
            if text:
                slog.info("%s", text.removeprefix("[listener] "))
        code = await proc.wait()
        if time.monotonic() - started > 60:
            backoff = 5  # ran fine for a while; reset backoff
        slog.error("sidecar exited with code %s — restarting in %ss", code, backoff)
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, SIDECAR_BACKOFF_MAX)


async def liveness_watchdog():
    """Force a restart if the Discord gateway stays dead — the failure mode
    where the bot silently stops replying and the logs go quiet."""
    dead_since = None
    last_heartbeat = 0.0
    while True:
        await asyncio.sleep(30)
        latency = bot.latency
        gateway_ok = bot.is_ready() and not bot.is_closed() and latency == latency  # NaN check
        now = time.monotonic()
        if gateway_ok:
            dead_since = None
            if now - last_heartbeat >= HEARTBEAT_EVERY:
                last_heartbeat = now
                log.info("heartbeat — gateway ok, latency %dms, %d guild(s)",
                         round(latency * 1000), len(bot.guilds))
        else:
            dead_since = dead_since or now
            log.warning("gateway not healthy (ready=%s closed=%s) for %ds",
                        bot.is_ready(), bot.is_closed(), int(now - dead_since))
            if now - dead_since > GATEWAY_DEAD_AFTER:
                log.critical("gateway dead for %ds — forcing process restart", GATEWAY_DEAD_AFTER)
                os._exit(1)


async def main():
    if not config.DISCORD_TOKEN:
        raise SystemExit("DISCORD_TOKEN environment variable is required.")
    if not config.OWNER_ID:
        log.warning("OWNER_ID is not set — owner-only management commands will deny everyone.")
    if not config.DASHBOARD_PASSWORD:
        log.warning("DASHBOARD_PASSWORD is not set — dashboard login is disabled.")
    if not config.SECRET_KEY:
        log.warning("SECRET_KEY is not set — dashboard sessions will reset on restart.")

    await db.init_db()

    app = create_app(bot)
    server = uvicorn.Server(uvicorn.Config(app, host="0.0.0.0", port=config.PORT, log_level="info"))

    async with bot:
        bot_task = asyncio.create_task(bot.start(config.DISCORD_TOKEN), name="discord-bot")
        web_task = asyncio.create_task(server.serve(), name="web-server")
        sidecar_task = asyncio.create_task(run_sidecar(), name="voice-sidecar")
        watchdog_task = asyncio.create_task(liveness_watchdog(), name="liveness-watchdog")
        done, pending = await asyncio.wait(
            [bot_task, web_task], return_when=asyncio.FIRST_COMPLETED
        )
        for task in (*pending, sidecar_task, watchdog_task):
            task.cancel()
        for task in done:
            task.result()  # re-raise whatever killed the finished task

    await db.close_db()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
