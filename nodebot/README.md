# nodebot — Max, rebuilt in Node.js

Fresh rebuild of Max from scratch, one layer at a time. This replaces the
Python bot (`bot/`) — not a second bot, not running alongside it. When this
is ready, it takes over and the Python code goes away.

## Current layer: connect + slash commands + text/voice AI chat + tools + persistence + moderation + welcome/autorole + automod

- `src/index.js` — client, logs in, opens the DB, handles slash commands,
  messages, and voice state updates
- `src/commands/ping.js` — `/ping`, proves the slash-command path works
- `src/commands/voicejoin.js` / `voiceleave.js` — owner-only, pin/unpin the
  voice channel to listen in
- `src/commands/kick.js` `ban.js` `unban.js` `timeout.js` `untimeout.js`
  `warn.js` `warnings.js` `clearwarnings.js` `purge.js` `slowmode.js`
  `lock.js` `unlock.js` — ported from the Python bot's moderation.py,
  owner-only via `utils.js`'s `requireOwner` (one inline check per command
  file rather than a cog-level interaction_check, since commands here are
  flat files, not a cog), logged via `utils.js`'s `logAction` (mod_logs +
  an embed to the configured log channel, same as bot/utils.py's
  log_action) — the first thing to actually exercise db.js's
  warnings/mod_logs tables
- `src/commands/createchannel.js` `deletechannel.js` `settopic.js`
  `giverole.js` `takerole.js` `createrole.js` `deleterole.js`
  `testwelcome.js` — ported from channels.py/roles.py/welcome.py, same
  owner-only + logAction pattern as the moderation commands
- `src/load-commands.js` — drops a new file in `src/commands/` to add a
  command, nothing else to wire up
- `src/deploy-commands.js` — registers commands with Discord
- `src/db.js` — SQLite persistence via `node:sqlite` (built into Node 22,
  zero native dependency to install/compile), same schema shape as the
  Python bot's db.py: per-guild settings, durable/profile memory + version
  history, the permanent chat-log/turns table, manuscripts, knowledge base,
  warnings, mod logs. IDs are stored as TEXT, not INTEGER like db.py —
  Discord snowflakes exceed `Number.MAX_SAFE_INTEGER`, and discord.js
  already hands them out as strings. Functions are synchronous
  (`DatabaseSync`, not a Promise API) since embedded SQLite has no real
  async I/O to await — same reasoning better-sqlite3 (the standard
  userland alternative) uses.
- `src/openrouter.js` — OpenRouter chat client with the tool-calling agent
  loop (ported from openrouter.py — the junk-verdict re-roll and spend-cap
  breaker are Python-side free-model-pool spend controls, deliberately not
  carried over yet, this is the core loop), abort-signal cancellation
  (needed for voice's cancel words to actually stop an in-flight reply),
  and an `onToolCalls` hook awaited once before the first round of tool
  calls actually executes (voice.js uses it for the "on it" heads-up)
- `src/tools.js` — general AI-callable tools: `web_search` (DuckDuckGo) so
  far; GitHub/sandbox tools follow once their own identity/write pieces
  exist here
- `src/agentTools.js` — the owner's *management* tools, ported wholesale
  from the Python bot's bot/agent_tools.py: all 25 of them (server/member/
  role/channel lookups, kick/ban/unban/timeout/untimeout/warn/warnings/
  clear_warnings/purge/slowmode/lock, create/delete channel, set topic,
  send_message, give/take/create/delete role). This is what lets the owner
  just *ask* Max to kick someone in chat or voice instead of typing
  `/kick` — the moderation slash commands and these tools both end up
  calling the same Discord actions and logging through the same
  `logAction`, they're just two different front doors to the same
  capability. Owner-only, checked both when the tool list is built (a
  non-owner never even sees these schemas) and again inside execute()
  (defense in depth, same as the Python bot).
- `src/knowledge.js` — `kb_search`/`kb_list`/`kb_save`: procedural memory
  ("how to do X"), guild-scoped, backed by db.js, ported from the Python
  bot's knowledge.py — separate from tools.js because these need a guildId
  the generic tool dispatch doesn't carry, same reason the Python bot
  routes kb_* calls separately from its generic tools.run_tool
- `src/persona.js` — the default system prompt, plus `OWNER_NOTE`/
  `MEMBER_NOTE` (ported from ai.py) telling the model whether it actually
  has agentTools hands right now or should point a regular member at a
  slash command instead — appended based on who's actually talking, so it
  never claims or denies capabilities that don't match reality for this
  speaker. `ai_system_prompt` in guild_settings overrides the base prompt
  per guild once set (no dashboard yet to set it from — that's later — but
  `/knowledge` proves the pattern works)
- `src/conversation.js` — **the actual point of this rebuild**: one shared
  per-guild turn buffer, not a separate one per modality. The Python bot's
  text history (ai.py) and voice transcript (voice.py) were two different
  in-memory structures the model never saw both of for immediate context —
  that's the "he doesn't know what I said in text when I ask in voice" gap.
  Both text and voice write into and read from this one buffer now — the
  gap is closed, not just narrowed. (Short-term/in-process, separate from
  db.js's permanent turns table — that's still a later layer.)
- `src/textChat.js` — replies when @mentioned (with web_search + knowledge
  base always, plus the full management toolset when the speaker is the
  owner), checks `ai_enabled`/`ai_model`/`ai_system_prompt` per guild,
  remembers every message (mentioned or not) into the shared buffer,
  tagged with which channel it happened in (`[#general]`) the same way the
  Python bot's memory does
- `src/transcription.js` — speech-to-text against any OpenAI-compatible
  `/audio/transcriptions` endpoint (OpenAI Whisper, Groq, ...)
- `src/tts.js` — Fish Audio when configured, free Microsoft Edge Read Aloud
  (via `msedge-tts`) otherwise; strips voice delivery tags for text display
- `src/voice.js` — join/leave/rebalance is adapted directly from
  `listener/index.js`'s proven DAVE E2EE join/capture (no reason to
  rewrite working audio plumbing) — what's new is that transcription, wake
  words, replies (same tool roster as text: web_search + knowledge base
  always, management tools when the speaker is the owner), and TTS all
  happen in-process now instead of over an HTTP bridge to a separate
  Python process, and read/write the same `conversation.js` buffer text
  chat uses. Respects `quiet_mode` (leaves/won't join, drops utterances
  during the gap before the next sweep) and per-guild wake/cancel words
  from db.js. Wake-word cooldown, a 1s grace window + cancel words ("never
  mind") that abort even an in-flight reply via `AbortController`, repeated-
  blip suppression, and — for the owner specifically — a spoken "on it —
  kicking alice, then posting in #general" heads-up (`describeToolCalls`,
  via `openrouter.js`'s new `onToolCalls` hook) before a chained action
  actually runs, are all ported from the Python bot's voice.py.
- `src/welcome.js` — `handleMemberAdd`/`handleMemberRemove`, wired to
  `GuildMemberAdd`/`GuildMemberRemove` in index.js: applies the `autorole`
  setting and posts the `welcome_message`/`goodbye_message` template
  (`{user}`/`{server}`/`{membercount}`, via `utils.js`'s new
  `formatTemplate`) to the configured `welcome_channel`. Ported from
  bot/cogs/welcome.py. Needs the `GuildMembers` privileged intent — also
  enable Server Members Intent in the Discord Developer Portal, same as
  the Python bot requires.
- `src/automod.js` — banned words, invite-link blocking, mention-spam
  limits (`automod_enabled`/`banned_words`/`block_invites`/`max_mentions`
  settings), ported from bot/cogs/automod.py. Runs independently of
  textChat.js on every message (index.js calls both for the same
  MessageCreate event, same as the Python bot's separate AutoMod/AI cogs
  both getting on_message) — a member with Manage Messages is exempt, and
  a caught violation gets deleted, logged via `logAction`, and gets a
  short-lived warning reply in the channel.

## Run it

```bash
cd nodebot
npm install
cp .env.example .env   # fill in DISCORD_TOKEN, CLIENT_ID, OWNER_ID, DEV_GUILD_ID, OPENROUTER_API_KEY
npm run deploy-commands
npm start
```

Uses the same token, same application, same bot identity as the live
Python bot — because it's not a different bot, it's Max being rebuilt.
Only run one of them connected at a time (Python bot stopped, or this one
stopped) so there's a single brain answering.

Needs `ffmpeg` on PATH for TTS playback (same as `listener/`) — already
provided by the repo's root `nixpacks.toml` in the Railway environment
this runs alongside.

## Test

```bash
npm test
```

Real automated tests (`node --test`, no extra dependency), not just manual
smoke checks: the shared conversation buffer (text+voice ordering,
per-guild isolation, capping), the full db.js persistence layer against a
real temp-file SQLite database (settings/DEFAULTS fallback, memory version
archiving, manuscripts, knowledge base, turns durability/permanent log,
warnings, mod logs), knowledge.js's slugify/formatting/dispatch, WAV
encoding correctness, voice-tag stripping, wake/cancel-word matching,
owner-check logic (`isOwner`/`requireOwner`/`execute` all take an
injectable owner-id override so the allow-branch is testable without
mutating real env state), `logAction` against a real DB with fake
guild/channel objects (records to mod_logs regardless of a log channel,
posts an embed when one's configured and reachable, degrades quietly when
it isn't), agentTools.js's resolution/target-checking/registry logic
against fake guild/member/channel objects built from real discord.js
`Collection`s (kicking, warning with a running count, creating a
channel/role, rejecting a bad hex color, rejecting a non-numeric unban id,
denying a non-owner), `describeToolCalls`'s blurb generation (including
malformed-JSON args and the empty/unrecognized-tool fallbacks), the
tool-calling agent loop's control flow including `onToolCalls` firing
exactly once before the first round (mocked fetch), web_search's
formatting (injected fake search function), automod.js's `findViolation`
(banned words / invite links / mention spam, priority order, the disabled
case) and `checkMessage` against fake message objects (skips bots/DMs,
skips Manage Messages holders, deletes+logs a real violation), and
welcome.js's member-add/-remove handlers (`formatTemplate` filling all
three placeholders, autorole application, "nothing configured" no-ops).
Slash *commands* themselves (moderation, channel/role, testwelcome)
aren't yet unit-tested end-to-end (that needs fuller discord.js
Interaction mocking — `interaction.deferReply`/`.editReply`, etc.) —
`requireOwner` and `logAction`, the pieces every one of them shares, are,
and agentTools.js's equivalent actions (same underlying Discord calls,
same log entries) are tested directly.

A couple of things can't be exercised live from this sandbox and are
tested via dependency injection / mocked fetch instead, noted in the test
files themselves: `duckduckgo.com` is blocked by this environment's
network egress allowlist (confirmed via a raw fetch returning 403 "Host
not in allowlist" — a testing-environment restriction, not a bug, same
category as an earlier restriction hit calling api.github.com and
discord.com directly), and OpenRouter itself isn't called live either
(tests set a fake `OPENROUTER_API_KEY` and mock global `fetch` to test the
loop's control flow, not real API reachability).

## Known gaps in this layer, on purpose

- GitHub read/write and sandbox tools need their own identity/write layer
  that doesn't exist here yet. `recall_chat_log` (search the permanent
  chat log) needs the turns table wired into conversation.js — schema
  exists, wiring doesn't yet.
- Settings exist (db.js) but there's no dashboard to set most of them from
  yet, beyond what `/knowledge`, the moderation commands' `log_channel`
  setting, and welcome/autorole/automod's settings prove out — wake/cancel
  words still fall back to env vars until a guild has its own row.
- No de-escalation/pressure (proactive speech) in voice yet.
- Single default persona unless `ai_system_prompt` is set directly in the
  DB — no per-guild dashboard UI for it yet.
- Slash commands (moderation, channel/role, testwelcome) aren't
  unit-tested end-to-end yet (see Test section above) — the shared
  owner-check/logging pieces are, and agentTools.js's equivalent actions
  are tested directly.

## Next layers (pick and choose, in whatever order makes sense)

- more AI tools: GitHub read (then write), sandbox, `recall_chat_log`
- dashboard

## Cutover

When this covers what you need: stop the Python process, point Railway's
start command at this instead, done.
