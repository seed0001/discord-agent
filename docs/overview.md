# Max — an AI agent that runs a Discord server

Max is a Discord bot with a personality: a laid-back vibe-coder who
happens to be the moderator, DJ of conversations, and resident engineer of
the server he manages. This document is the plain-language tour; see
`architecture.md` for how it's built.

## What Max does

**Chats like a person.** Mention him or talk in a designated AI channel and
he replies in persona — mellow, funny, technically sharp. He knows what
server he's in, who's around, and what his own commands can do.

**Manages the server.** Kick, ban, timeout, warn, purge, slowmode, lock;
create/delete channels (text, voice, category, forum) and roles; welcome
messages; automod with banned words, invite blocking, and mention-spam
limits. The owner can just *tell Max* what to do in plain language — he has
direct tools for all of it. Everyone else gets pointed to the slash
commands.

**Sits in voice and listens.** When people join a voice channel, Max joins
too (announcing that he's listening). Every speaker is transcribed
separately in near-real-time. Banned words get flagged to the mod log. Say
his wake word — "hey Max" — and he joins the conversation out loud, with
full context of everything said before, speaking through an expressive
neural voice.

**Speaks up when he has something to offer.** A pressure system watches
conversations (text and voice) for unresolved blockers, wrong technical
claims, stalled progress, and safety concerns. Pressure builds, decays, and
— rarely, deliberately — crosses a threshold where Max interjects once with
something useful. Strict gates stop him from spamming, repeating himself,
or butting into heated exchanges.

**Remembers, live.** A two-tier memory (working + durable) persists across
restarts: current conversation context on one shelf, long-term facts and
preferences on the other. It updates after every single turn, not on a
delay — say something in a text channel and it's already in memory the
next time he talks in voice, and vice versa.

**Looks things up.** Web search (DuckDuckGo) and GitHub repo analysis —
drop a repo link and he'll pull its stats, languages, and README and
actually discuss it.

**Reads what you hand him.** Attach a document to a message he sees — a
text file, markdown, code, a PDF, a Word doc — and he reads it
automatically, no command needed. Summarize it, answer questions about it,
review it: he engages with the actual content, not just the filename.

## How you run him

A mobile-friendly web dashboard covers everything: member management,
channel/role editing, settings, automod, the AI's persona, a live voice
transcription console, live logs, and start/stop/restart controls. Slash
commands mirror most of it inside Discord, and the owner can simply ask
Max himself.

## The cast of files

- `bot/` — the Discord bot (Python, discord.py)
- `listener/` — the voice listener sidecar (Node.js, discord.js)
- `web/` — the dashboard (FastAPI + vanilla JS)
- `pressure/` — the proactive-speech decision engine
- `memory.py`, `tts.py`, `transcription.py`, `tools.py` — the organs
- `docs/` — you are here
