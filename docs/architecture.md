# Architecture

Technical map of the system: processes, components, data flow, storage.

## Process model

One Railway container runs a single supervised process tree:

```
python main.py
 ├─ discord bot        (discord.py gateway session #1)
 ├─ uvicorn web server (dashboard + APIs, port $PORT)
 ├─ node listener/     (subprocess: discord.js gateway session #2,
 │                      voice only — stdout piped into python logging,
 │                      auto-restarted with backoff if it dies)
 └─ liveness watchdog  (force-exits non-zero if the Discord gateway is
                        dead >5 min; the platform restarts the container)
```

Both gateway sessions use the same bot token — Discord allows multiple
sessions per token. Only the Node sidecar connects to *voice* (it speaks
Discord's DAVE E2EE protocol via discord.js + @snazzah/davey, which no
Python library supports); the Python side never joins voice.

## Components

### Python bot (`bot/`)
- `client.py` — bot setup, cog loading, presence, command sync
- `cogs/moderation|roles|channels|welcome|automod|utility` — classic
  server management (slash commands, owner-gated)
- `cogs/ai.py` — conversational AI via OpenRouter: persona (per-guild
  setting) + self-awareness prompt (command list, server info, memory
  block); tool-calling loop (web search, GitHub analysis, and for the
  owner the direct management tools in `agent_tools.py`)
- `cogs/voice.py` — the content half of voice: transcription calls,
  rolling per-channel transcripts, banned-word flags, wake-word replies
  (text + TTS), push-to-speak, noise suppression
- `cogs/proactive.py` — wires the pressure engine to live conversation
  (classification, tick loop, drafting, sending)

### Voice listener sidecar (`listener/index.js`)
Auto-joins the busiest occupied voice channel per guild, receives each
speaker's decrypted audio as separate Opus streams, decodes to PCM,
segments utterances by 1s silence, applies noise gates (min duration, min
RMS loudness), and POSTs raw PCM to the internal API. Plays TTS audio back
(both wake replies and pushed proactive speech). Self-heals zombie
connections and stalled subscriptions; control API on localhost for
join/leave/speak/status.

### Web (`web/`)
- `api.py` — dashboard REST API (cookie auth, `DASHBOARD_PASSWORD`)
- `internal.py` — localhost API for the sidecar (auth: `SECRET_KEY`):
  voice-config, voice-event, utterance
- `static/` — single-page dashboard: overview (restart), members, server,
  voice console (live transcripts, start/stop), mod tools, live logs,
  settings

### Pressure engine (`pressure/`)
Deterministic decision core for unprompted speech: signals → buckets
(charge/decay/flow) → speaking gate (threshold, relevance, novelty,
repetition, cooldowns, budget, energy, interruption) → discharge.
Persisted per guild in its own SQLite file. See `pressure/AUDIT.md` for
its lineage (adapted from seed0001/digital-pressure) and
`pressure/README.md` for the model.

### Cross-cutting organs
- `memory.py` — two-tier persistent memory (working refreshed every 5
  turns, durable consolidated every ~45), injected into every prompt
- `openrouter.py` — chat-completions client with OpenAI-style tool loop
- `transcription.py` — OpenAI-compatible `/audio/transcriptions` client
  with hallucination filtering
- `tts.py` — Fish Audio (S1/S2 tag styles) with edge-tts fallback
- `tools.py` — web_search + github_repo tools
- `documents.py` — extracts text from message attachments (txt/md/code,
  PDF, docx) so the AI can review dropped-in files
- `logbuffer.py` — ring buffer feeding the dashboard Logs tab

## Data flow: a voice utterance, end to end

```
speaker → Discord voice (DAVE E2EE)
  → sidecar: decrypt, decode, segment, noise-gate
  → POST /internal/utterance (raw PCM, SECRET_KEY auth)
  → voice cog: transcribe (Whisper API) → junk/repeat filters
      → transcript console, mod-log flags, memory turn,
        pressure classification
      → wake word? → AI reply with transcript context
        → text to channel + TTS mp3 back to sidecar → speakers
```

## Storage

| Store | Contents |
|---|---|
| `$DATABASE_PATH` (SQLite) | guild settings, warnings, mod logs, memory (+versions) |
| `pressure-<guild>.db` | pressure signals, buckets, cooldowns, decisions |
| in-memory | chat history rings, transcripts, log buffer |

All SQLite files live on the Railway volume and survive redeploys.

## External services

OpenRouter (chat + tool calls), an OpenAI-compatible transcription API
(OpenAI or Groq), Fish Audio (TTS, optional), DuckDuckGo (search), GitHub
API (repo analysis). All keys via environment variables — see
`operations.md`.
