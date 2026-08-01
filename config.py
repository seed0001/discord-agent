"""Environment-driven configuration."""
import os
import time

# Process start stamp — used to cache-bust dashboard assets and shown as
# the dashboard build id
BUILD_ID = str(int(time.time()))

DISCORD_TOKEN = os.environ.get("DISCORD_TOKEN", "")
OWNER_ID = int(os.environ.get("OWNER_ID", "0") or "0")
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
OPENROUTER_MODEL = os.environ.get("OPENROUTER_MODEL", "anthropic/claude-3.5-haiku")
# Model for background work (classification, memory, assessments) — these
# are ~85% of call volume and don't need the conversational model.
# "openrouter/free" routes across OpenRouter's free-model pool at $0.
OPENROUTER_UTILITY_MODEL = os.environ.get("OPENROUTER_UTILITY_MODEL", "openrouter/free")
# Hard hourly cap on background model calls (0 disables the cap)
OPENROUTER_BG_HOURLY_CAP = int(os.environ.get("OPENROUTER_BG_HOURLY_CAP", "240"))
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")
# The repo Max lives in — enables full GitHub visibility (branches, PRs,
# diffs, commits, files at any ref), not just the locally checked-out tree
GITHUB_REPO = os.environ.get("GITHUB_REPO", "seed0001/discord-agent")
# E2B API key — powers the sandbox tools (clone/install/run/edit/screenshot
# arbitrary repos in a disposable cloud VM, owner-only). https://e2b.dev
E2B_API_KEY = os.environ.get("E2B_API_KEY", "")
# GitHub token with write access, used only by the sandbox push tool. Kept
# separate from GITHUB_TOKEN (read-only repo analysis) so the write path can
# be revoked/rotated independently of the read path.
GITHUB_WRITE_TOKEN = os.environ.get("GITHUB_WRITE_TOKEN", "")
# Voice transcription: any OpenAI-compatible /audio/transcriptions endpoint
TRANSCRIPTION_API_KEY = os.environ.get("TRANSCRIPTION_API_KEY", "")
TRANSCRIPTION_API_URL = os.environ.get("TRANSCRIPTION_API_URL", "https://api.openai.com/v1")
TRANSCRIPTION_MODEL = os.environ.get("TRANSCRIPTION_MODEL", "whisper-1")
# Control API of the Node.js voice listener sidecar (listener/)
SIDECAR_URL = os.environ.get("SIDECAR_URL", "http://127.0.0.1:8091")
# Fish Audio TTS (used for voice replies when the key is set; edge-tts otherwise)
FISH_API_KEY = os.environ.get("FISH_API_KEY", "")
FISH_TTS_MODEL = os.environ.get("FISH_TTS_MODEL", "s2.1-pro-free")
FISH_VOICE_ID = os.environ.get("FISH_VOICE_ID", "")
DASHBOARD_PASSWORD = os.environ.get("DASHBOARD_PASSWORD", "")
SECRET_KEY = os.environ.get("SECRET_KEY", "")
DATABASE_PATH = os.environ.get("DATABASE_PATH", "data/bot.db")
PORT = int(os.environ.get("PORT", "8000"))
