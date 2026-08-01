# Discord Agent

A Node.js Discord bot that manages your server end-to-end, with a mobile-friendly web
dashboard and AI chat powered by OpenRouter. Designed to deploy on Railway from GitHub
as a single service (bot + dashboard + voice in one process).

The bot lives in [`nodebot/`](nodebot/). The Python tree at the repo root is the
previous implementation, kept for reference until it's deleted — it is never
installed and never started.

Docs: [overview](docs/overview.md) · [architecture](docs/architecture.md) ·
[voice pipeline](docs/voice-pipeline.md) · [operations](docs/operations.md) ·
[how Max thinks](docs/how-max-thinks.md) (concepts: pressure, memory,
tools, wake pipeline, prompts, models, limitations, roadmap)

## Features

**Bot (slash commands)**
- Moderation: `/kick` `/ban` `/unban` `/timeout` `/untimeout` `/warn` `/warnings`
  `/clearwarnings` `/purge` `/slowmode` `/lock` `/unlock`
- Roles: `/giverole` `/takerole` `/createrole` `/deleterole`
- Channels: `/createchannel` `/deletechannel` `/settopic`
- Utility: `/ping` `/serverinfo` `/userinfo` `/say`
- AI: `/ask`, `/aireset`, `/manuscript`, `/knowledge`, and the bot replies
  whenever it's @mentioned
- AI tools: DuckDuckGo web search, GitHub repo analysis (share a repo link
  and the bot pulls its stats, languages, and README to discuss it), and
  full read-only visibility into the bot's own GitHub repo — every branch,
  contributor pull requests with full diffs, branch comparisons, commits,
  and file contents at any ref, for reviewing contributor work together
  in chat. Read-only, no create/update/delete/merge call anywhere in that
  path — merging is always a human decision.
- Repo sandbox (E2B): **not available.** This existed in the Python bot and was
  deliberately not carried over to Node — it never worked well in practice.
  `E2B_API_KEY` and `GITHUB_WRITE_TOKEN` are unused.
- Document review: drop a file on a message that mentions the bot (or in
  an always-on AI channel) — text, markdown, code, PDFs, and Word docs are
  read automatically and folded into the conversation so the bot can
  summarize, answer questions about, or review what's in them.
- Proactive speech: a pressure engine (`pressure/`, adapted from
  digital-pressure) lets the bot speak unprompted — messages and voice
  transcripts are classified into weighted signals (blockers, wrong claims,
  promised follow-ups, safety concerns…); pressure charges, decays, and
  flows, and a deterministic gate (thresholds, relevance, novelty,
  cooldowns, budgets, energy) rules on every drafted contribution —
  `/pressure` shows state or toggles it (owner)
- Persistent memory, updated live: a working-memory file (current topic,
  open questions, recent meaningful turns), a durable-memory file (dated
  facts/preferences/decisions with confidence), and a per-member profile
  card (goals, active projects, constraints, vibe notes, freeform notes)
  are all rewritten after every single turn — text or voice, from anyone,
  in every channel, tagged with exactly where it happened (`#general`,
  `voice/General`, ...) — so something posted in one channel can be
  recalled later from a completely different channel or from voice, no
  batching delay; stored versioned in SQLite, injected into every reply;
  `/memory` shows or wipes it (owner). Every raw turn is also persisted
  immediately (before consolidation runs) and kept forever as a permanent,
  searchable chat log — if a redeploy hits mid-consolidation, unconsolidated
  turns are replayed on restart instead of lost, and the bot can search the
  actual log (`recall_chat_log`) whenever a summary alone doesn't have it
- Manuscript (owner-only, always on — no toggle, nothing to remember to
  enable): every word the owner says, voice or text, is separately kept
  verbatim — for long-form stuff meant to be kept word for word, like a
  life story or a book draft, instead of boiled down into a fact or a
  profile field. Completely separate from durable memory and profile
  cards, never summarized, compressed, or rewritten. `/manuscript` sends
  it back as a text file, or clears it
- Knowledge base: procedural memory, separate from durable/working/profile
  memory (which is facts about people) — reusable "how to do X" steps.
  Before improvising an unfamiliar multi-step task, or asking how to do
  something, the bot checks it first (`kb_search`); if nothing matches, it
  asks instead of guessing, then saves the resolved procedure (`kb_save`)
  so nobody has to walk it through the same thing twice. Guild-wide, not
  tied to one person; `/knowledge` lists or searches it, and the owner can
  delete an entry
- Voice monitoring (in-process): the bot joins occupied voice channels itself,
  speaking Discord's DAVE E2EE voice protocol via discord.js, receives each
  speaker separately, transcribes them, flags banned words to the mod log, and
  joins the conversation (text + TTS) when someone says a wake word —
  `/voicejoin` `/voiceleave` (needs `TRANSCRIPTION_API_KEY`). Text and voice
  share one conversation buffer, so asking about something in voice that was
  said in text works, and vice versa. The old `listener/` sidecar and the HTTP
  bridge it needed are gone — no second process, no `SIDECAR_PORT`.
- Follow-up mode: the wake word only has to be said **once**. For 25 seconds
  after Max finishes speaking, anyone in the channel can just keep talking and
  he answers, and every real answer re-arms the window — so a conversation
  carries on the way it would with a person. Two ways to end it: **"Max, stop
  speaking"** cuts him off mid-sentence but stays in the conversation, and
  **"Max, stop listening"** ends it and puts the wake word back. If what he
  hears in the window plainly wasn't meant for him, he stays quiet. All of it
  is per-server and editable from the dashboard (`voice_followup_enabled`,
  `voice_followup_window_sec`, `voice_stop_speaking_words`,
  `voice_stop_listening_words`); set the window to `0` to turn it off.
- Phrases, not words: wake / cancel / stop lists are entered on the dashboard
  as `[hey max] [max, you around?] [yo max]` — one phrase per bracket pair, so
  a phrase can contain a comma. The old comma-separated form still parses, so
  nothing breaks mid-edit. Capitals and punctuation are ignored on both sides
  when matching, and what's stored is the tidied-up version, so what you see
  on the dashboard is exactly what gets compared.
- Welcome/goodbye messages + autorole for new members
- Automod: banned words, invite-link blocking, mention-spam limits
- Mod log channel + persistent action history

**Dashboard** (mobile-first, works great from a phone)
- Overview: server + bot stats
- Members: search, warn/timeout/kick/ban, edit roles
- Server: create/delete channels & roles, send messages as the bot
- Mod: warning list, full moderation log
- Settings: welcome, automod, AI model/prompt/channels, log channel, bot presence

## Setup

### 1. Create the Discord application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**.
2. **Bot** tab → copy the **Token** (this is `DISCORD_TOKEN`).
3. On the same tab, enable **Privileged Gateway Intents**:
   - ✅ Server Members Intent
   - ✅ Message Content Intent
4. **OAuth2 → URL Generator**: check `bot` + `applications.commands` scopes, and give it
   **Administrator** (or the specific permissions you want). Open the generated URL to
   invite the bot to your server.

### 2. Get an OpenRouter key

Create a key at [openrouter.ai/keys](https://openrouter.ai/keys) — this is `OPENROUTER_API_KEY`.

### 3. Deploy on Railway

1. Push this repo to GitHub.
2. In [Railway](https://railway.app): **New Project → Deploy from GitHub repo** and pick it.
3. Add these variables (service → **Variables**):

   | Variable | Value |
   |---|---|
   | `DISCORD_TOKEN` | your bot token |
   | `CLIENT_ID` | your Discord **application ID** — required to register slash commands |
   | `OWNER_ID` | your Discord user ID (management commands are owner-only) |
   | `OPENROUTER_API_KEY` | your OpenRouter key |
   | `DASHBOARD_PASSWORD` | password for the dashboard |
   | `SECRET_KEY` | any long random string |
   | `DATABASE_PATH` | `/data/nodebot.db` |
   | `GITHUB_TOKEN` | *(optional)* GitHub token — raises the repo-analysis API rate limit |
   | `TRANSCRIPTION_API_KEY` | *(optional)* OpenAI or Groq key — enables voice monitoring |
   | `FISH_API_KEY` | *(optional)* fish.audio key — natural TTS voice for spoken replies |
   | `FISH_VOICE_ID` | *(optional)* fish.audio voice model reference id to speak with |
   | `FISH_TTS_MODEL` | *(optional)* fish.audio model, default `s2.1-pro-free` (free tier) |

4. Attach a **Volume** to the service mounted at `/data` (so settings/warnings survive
   redeploys).
5. Settings → **Networking → Generate Domain** to get your dashboard URL.

Open the domain on your phone, log in with `DASHBOARD_PASSWORD`, and manage everything
from there.

### Run locally

Needs Node 22.5+ and `ffmpeg` on PATH for TTS playback.

The bot stores everything in `node:sqlite`, which is built into Node but not
switched on across all of Node 22: it landed in 22.5.0 behind
`--experimental-sqlite` and was only unflagged in 22.13.0. The npm scripts and
the deploy start command pass that flag unconditionally — it is required at or
below 22.12 and a harmless no-op above it. If you run a script directly rather
than through `npm`, pass it yourself or you'll get
`ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module: node:sqlite`.

```bash
cd nodebot
npm install
cp .env.example .env          # fill it in
npm run deploy-commands       # register slash commands (needs CLIENT_ID)
npm start
```

Run the tests with `npm test` from `nodebot/`.

Dashboard: http://localhost:8000

### Dashboard access levels

One instance runs one server, and dashboard access follows that server's own
Discord roles — there's no second list of people to keep in step.

| Level | Who | What they get |
|---|---|---|
| **creator** | `OWNER_ID`, plus the `DASHBOARD_PASSWORD` login | Everything, including the bot's global log, presence, and restart |
| **admin** | Discord `Administrator`, or a role in `dashboard_admin_roles` | Everything for the server: persona, models, voice, automod, welcome, channels and roles |
| **moderator** | A role in `dashboard_mod_roles` | Members, warnings, mod log, transcripts, quiet mode. Read-only on settings |

People sign in with **Sign in with Discord**; the bot then looks them up in
its own server over the gateway and reads their roles from there — never from
anything the browser sent. Map the roles under **Settings → Dashboard access**.

Leave both role lists empty and it falls back to Discord's own permissions, so
a fresh install works before it's configured: Manage Server counts as admin,
and kick/ban/timeout counts as moderator. Once you map roles, those become the
source of truth. `OWNER_ID` is always creator and cannot be locked out, and the
password login stays as break-glass if OAuth is misconfigured.

To enable Discord login, add to the Discord Developer Portal → your app →
OAuth2 → **Redirects**: `https://<your-dashboard>/api/auth/callback`, then set
`DISCORD_CLIENT_SECRET` (and `PUBLIC_URL` if a proxy rewrites `Host`). Without
the secret, the dashboard stays password-only.

Levels are enforced per route on the server, not just hidden in the UI, and a
route that doesn't declare a level is treated as creator-only — so a new one
fails closed rather than open.

### Persona: two halves

The system prompt is assembled from two separately editable settings, both on
the dashboard's Overview tab:

| Setting | What it is |
|---|---|
| `ai_system_prompt` | **Character** — who he is, how he talks. Yours to write. |
| `ai_capability_prompt` | **Capability** — what he can actually do. |

Both default to the text in `src/persona.js`. A server that has never saved its
own copy keeps getting the current default, so neither can be lost to a fresh
database, and the capability half stays true as features land. Save either from
the dashboard and that server is pinned to its own copy from then on — nothing
overwrites it afterwards.

The slash-command list is **not** part of either one. It's generated from the
live command table on every request (`src/systemPrompt.js`), so it can't go
stale, and a stored persona can never claim a command that no longer exists.

Full assembly order: character → who he is and which server he runs, with the
command list → capability → owner or member note → what he remembers. Text
chat and voice call the same builder, so the two surfaces can't describe
different bots.

> Keep the capability half honest. A persona that claims a tool the bot doesn't
> have produces a bot that confidently lies about what it did. `npm test`
> enforces this: every tool and slash command named in `CAPABILITY_PROMPT` must
> actually exist.

### Migrating from the Python bot

Settings (persona, welcome messages, banned words, log channel, autorole,
model override, wake words) carry across; chat history and memories do not:

```bash
node --experimental-sqlite nodebot/src/migrate-settings.js --from /data/bot.db --to /data/nodebot.db
```

Add `--dry-run` to see what would move without writing anything.

**Point `DATABASE_PATH` at a new file — not the Python bot's `bot.db`.** Both
schemas use the same table names, so `CREATE TABLE IF NOT EXISTS` is a no-op
against the old database and the bot would come up looking healthy while
mangling every Discord id: Python stores snowflakes as `INTEGER`, and anything
past 2^53 comes back to JS as a rounded float (`1234567890123456789` →
`...800`), so warnings, mod logs and per-member memory would key to the wrong
user. The bot detects this at startup and refuses to start rather than corrupt
data, printing the migration command above.

> Note: locally the session cookie is marked `secure`, which most browsers still accept
> on `localhost`. Slash commands are synced per-guild on startup, so they appear
> immediately in servers the bot is already in.

## Notes

- All state lives in one SQLite file (`DATABASE_PATH`). Without a Railway volume it
  resets on each deploy.
- AI model, system prompt, and always-on AI channels are per-server settings in the
  dashboard. Any [OpenRouter model ID](https://openrouter.ai/models) works.
- The dashboard is a single password for full control — use a strong one, and keep the
  Railway domain private.
- Management commands (moderation, roles, channels, welcome, `/say`) only work for the
  user whose ID is in `OWNER_ID`. AI chat (`/ask`, @mentions) and info commands
  (`/ping`, `/serverinfo`, `/userinfo`) are open to everyone.
