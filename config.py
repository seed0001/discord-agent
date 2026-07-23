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
# Control API of the Node.js voice listener sidecar (listener/)
SIDECAR_URL = os.environ.get("SIDECAR_URL", "http://127.0.0.1:8091")
# Fish Audio TTS (used for voice replies when the key is set; edge-tts otherwise)
FISH_API_KEY = os.environ.get("FISH_API_KEY", "")
FISH_TTS_MODEL = os.environ.get("FISH_TTS_MODEL", "s1")
FISH_VOICE_ID = os.environ.get("FISH_VOICE_ID", "")
DASHBOARD_PASSWORD = os.environ.get("DASHBOARD_PASSWORD", "")
SECRET_KEY = os.environ.get("SECRET_KEY", "")
DATABASE_PATH = os.environ.get("DATABASE_PATH", "data/bot.db")
PORT = int(os.environ.get("PORT", "8000"))
