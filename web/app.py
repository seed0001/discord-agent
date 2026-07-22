"""FastAPI app serving the dashboard UI and REST API."""
import os

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

import discord

from web.api import router

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")


def create_app(bot) -> FastAPI:
    app = FastAPI(title="Discord Agent Dashboard", docs_url=None, redoc_url=None)
    app.state.bot = bot
    app.include_router(router, prefix="/api")
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    @app.exception_handler(discord.Forbidden)
    async def forbidden_handler(request, exc):
        return JSONResponse(status_code=403, content={
            "detail": "The bot lacks permission for that. Check its role position and permissions."})

    @app.exception_handler(discord.HTTPException)
    async def discord_error_handler(request, exc):
        return JSONResponse(status_code=502, content={"detail": f"Discord error: {exc.text}"})

    @app.get("/")
    async def index():
        return FileResponse(os.path.join(STATIC_DIR, "index.html"))

    @app.get("/health")
    async def health():
        return {"ok": True, "bot_ready": bot.is_ready()}

    return app
