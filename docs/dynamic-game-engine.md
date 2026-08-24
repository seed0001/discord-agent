# Dynamic Game Engine (branch: `dynamic-game-engine`)

A server-wide, D&D-derivative game system built as new modules inside Max's
existing codebase — not a separate bot. Max is the gatekeeper, the mod, and
the DM: one persona, one process. This branch is where that work happens;
`main` (the deployed bot) is not touched until this is ready to merge.

Owner: Travis. Final say on all admissions.

---

## Why this lives here, not in a new repo

Max already has most of the hard infrastructure this needs, running and
proven in production:

| Need | Already exists |
|---|---|
| Voice: join a channel, hear people, speak back | `nodebot/src/voice.js` — DAVE E2EE, per-speaker transcription, wake-word + follow-up conversation, Fish Audio TTS |
| AI decision-making / tool-calling | OpenRouter chat-completions loop already wired |
| Server management (create channel/role, welcome/autorole) | `cogs`/slash commands already owner-gated |
| Image generation | OpenRouter image gen already integrated |
| Persistent memory per member | SQLite working/durable memory + profile cards |
| Admin surface | Existing dashboard (mobile-first) |

Net-new work is the *game layer* on top of that: lobby gating/interview
decision workflow, World/Theme data model, character creation (incl. a new
code-rendered stat-card compositor), forum roster posting, game-state
(turns/dice), and a Discord Activity for shared live play.

---

## 1. Onboarding & Gatekeeping

- New member joins the guild → **Unverified** role, can only see a **Lobby**
  voice channel (+ waiting-room text channel with basic rules).
- Max detects them joining the Lobby VC (reuses existing voice-join handling)
  and starts a live interview using the existing STT/TTS pipeline.
- Interview covers, in order:
  1. Opening: server vibe (chill, no judgment, pretty open), Travis has final
     say on who stays.
  2. "How familiar are you with tabletop RPGs / D&D-style games?"
  3. "What kind of games/settings would you be into?" (feeds World assignment)
  4. "How'd you find us, do you know anyone here?" (feeds mod summary, can
     auto-tag a named inviter)
  5. "Are you comfortable working with an AI throughout this?"
  6. Close: thanks them, decision coming.
- Max posts a **summary + recommendation** to a mod-only channel — does not
  decide alone. Travis (or another admin) approves/rejects.
- **Approved** → role flips to full member → character creation begins.
- **Rejected** → kicked. Can be re-invited fresh later.

## 2. Worlds

A **World** = paired Voice Channel + Forum Channel + Theme config, spun up
by Max as a mod action (reuses `createchannel`-style tooling).

- Worlds **coexist** — creating a new one never resets an existing one.
  Different characters can be mid-story in different settings (fantasy,
  space, animals, aliens, whatever) simultaneously.
- Each World's Theme config: class/stat schema, card style reference images
  (front + back), tone/setting description fed into the DM system prompt.
- **Open**: does Travis supply reference images per new World, or does Max
  propose a style for approval first? Not yet decided.

## 3. Character Card Pipeline

Two reference images **per World** set the style once:

- **Front (portrait)**: reference sets frame/border/outline style. Max
  generates each character's unique portrait to match (existing image-gen
  path) — uniform per World, unique per character.
- **Back (stats)**: reference sets layout/background only. Actual stats are
  **code-rendered as real text** (new: Canvas/HTML → image) onto that
  template — deliberately not AI-generated text, since image models render
  precise text unreliably and this needs to update accurately whenever
  stats change.

## 4. Character Roster (per-World Forum)

- One thread per character. Opening post = the card + starting stats +
  backstory. Ongoing narrative posted by Max as **replies** in-thread (not
  edits to one message) — visible history, supports discussion.
- Tags: **Active** / **Fallen**.

## 5. Death & Reroll

- Permadeath. Thread tagged **Fallen**, locked as a memorial (backstory
  intact, no deletion). Player re-enters character creation for a new one.

## 6. Live Play

- A **Discord Activity** (Embedded App SDK), launched from a World's voice
  channel, shared on-screen for whoever's in that call: map, turn order,
  dice, action buttons.
- Max narrates via TTS (existing pipeline) + mirrors text/buttons, loaded
  with that World's theme/context specifically.
- Worlds run concurrently → the system needs to support **multiple live
  sessions at once**, each scoped to its own World. Bigger build item than
  it first looks — flagged.

## 7. Net-new modules (what actually gets built on this branch)

- `lobby/` — gating role logic, interview state machine, mod-approval flow
- `worlds/` — World/Theme data model, World creation tool
- `characters/` — character creation flow, stat-card compositor (new
  Canvas/HTML rendering piece), roster forum posting
- `game/` — session/turn/dice state, per-World concurrency
- Activity — separate iframe web app for live play, talks to the same
  backend/DB

## 8. Open Questions

- New-World card style: Travis supplies images, or Max proposes for
  approval?
- On death, does reroll stay in the same World or can it move to another?
- Full scope of Max's general "mod" duties beyond World provisioning.
- STT/TTS cost at scale now that the interview is the first thing every new
  member experiences.

## 9. Suggested Build Order

1. Lobby gating (roles/permissions) + interview loop using existing voice
   pipeline (no decision logic yet)
2. Interview → recommendation → mod approve/reject → role flip
3. World concept: paired VC+Forum creation, Theme config schema
4. Character creation (portrait gen + code-rendered stat card) + roster
   forum posting
5. Backend/DB wiring for persistent World/character state
6. Discord Activity for live play, per-World session support
