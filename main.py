"""Entry point: runs the Discord bot and the dashboard web server in one process."""
import asyncio
import logging

import uvicorn

import config
import db
from bot.client import bot
from web.app import create_app

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("main")


async def main():
    if not config.DISCORD_TOKEN:
        raise SystemExit("DISCORD_TOKEN environment variable is required.")
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
        done, pending = await asyncio.wait(
            [bot_task, web_task], return_when=asyncio.FIRST_COMPLETED
        )
        for task in pending:
            task.cancel()
        for task in done:
            task.result()  # re-raise whatever killed the finished task

    await db.close_db()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
