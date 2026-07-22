"""Environment-driven configuration."""
import os

DISCORD_TOKEN = os.environ.get("DISCORD_TOKEN", "")
OWNER_ID = int(os.environ.get("OWNER_ID", "0") or "0")
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
OPENROUTER_MODEL = os.environ.get("OPENROUTER_MODEL", "anthropic/claude-3.5-haiku")
DASHBOARD_PASSWORD = os.environ.get("DASHBOARD_PASSWORD", "")
SECRET_KEY = os.environ.get("SECRET_KEY", "")
DATABASE_PATH = os.environ.get("DATABASE_PATH", "data/bot.db")
PORT = int(os.environ.get("PORT", "8000"))
