# Discord Agent

A Python Discord bot that manages your server end-to-end, with a mobile-friendly web
dashboard and AI chat powered by OpenRouter. Designed to deploy on Railway from GitHub
as a single service (bot + dashboard in one process).

## Features

**Bot (slash commands)**
- Moderation: `/kick` `/ban` `/unban` `/timeout` `/untimeout` `/warn` `/warnings`
  `/clearwarnings` `/purge` `/slowmode` `/lock` `/unlock`
- Roles: `/giverole` `/takerole` `/createrole` `/deleterole`
- Channels: `/createchannel` `/deletechannel` `/settopic`
- Utility: `/ping` `/serverinfo` `/userinfo` `/say`
- AI: `/ask`, `/aireset`, and the bot replies whenever it's @mentioned
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
   | `OWNER_ID` | your Discord user ID (management commands are owner-only) |
   | `OPENROUTER_API_KEY` | your OpenRouter key |
   | `DASHBOARD_PASSWORD` | password for the dashboard |
   | `SECRET_KEY` | any long random string |
   | `DATABASE_PATH` | `/data/bot.db` |

4. Attach a **Volume** to the service mounted at `/data` (so settings/warnings survive
   redeploys).
5. Settings → **Networking → Generate Domain** to get your dashboard URL.

Open the domain on your phone, log in with `DASHBOARD_PASSWORD`, and manage everything
from there.

### Run locally

```bash
python -m venv .venv
.venv\Scripts\activate        # Windows (source .venv/bin/activate on mac/linux)
pip install -r requirements.txt
copy .env.example .env        # fill it in, then load it into your shell
python main.py
```

Dashboard: http://localhost:8000

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
