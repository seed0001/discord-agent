"""Environment-driven configuration."""
import os

DISCORD_TOKEN = os.environ.get("DISCORD_TOKEN", "")
OWNER_ID = int(os.environ.get("OWNER_ID", "0") or "0")
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
OPENROUTER_MODEL = os.environ.get("OPENROUTER_MODEL", "anthropic/claude-3.5-haiku")
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")
# Voice transcription: any OpenAI-compatible /audio/transcriptions endpoint
TRANSCRIPTION_API_KEY = os.environ.get("TRANSCRIPTION_API_KEY", "")
TRANSCRIPTION_API_URL = os.environ.get("TRANSCRIPTION_API_URL", "https://api.openai.com/v1")
TRANSCRIPTION_MODEL = os.environ.get("TRANSCRIPTION_MODEL", "whisper-1")
DASHBOARD_PASSWORD = os.environ.get("DASHBOARD_PASSWORD", "")
SECRET_KEY = os.environ.get("SECRET_KEY", "")
DATABASE_PATH = os.environ.get("DATABASE_PATH", "data/bot.db")
PORT = int(os.environ.get("PORT", "8000"))
