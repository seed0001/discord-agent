/* The catalog — one source of truth for tiers and capabilities.
   The pricing matrix and the bot builder both read from here, so a
   capability can never be listed in one place and missing from the other. */

const TIERS = [
  {
    id: 'hobby',
    name: 'Hobby',
    tagline: 'Get him in the server.',
    price: 0,
    priceNote: 'free forever',
    blurb:
      'The full moderation stack and a bot that talks back. Enough to run a small server without paying anything.',
    limits: {
      servers: '1 server',
      messages: '300 AI replies / mo',
      voice: 'no voice',
      models: 'free model pool',
    },
    cta: 'Start free',
  },
  {
    id: 'core',
    name: 'Core',
    tagline: 'He remembers everything.',
    price: 19,
    priceNote: 'per server, per month',
    blurb:
      'Persistent memory, your own persona, the whole model catalog, and the tools that let him look things up instead of guessing.',
    limits: {
      servers: '3 servers',
      messages: '10,000 AI replies / mo',
      voice: 'no voice',
      models: 'any OpenRouter model',
    },
    cta: 'Choose Core',
  },
  {
    id: 'voice',
    name: 'Voice',
    tagline: 'He sits in the channel.',
    price: 49,
    priceNote: 'per server, per month',
    popular: true,
    blurb:
      'Joins voice, transcribes every speaker separately, and answers out loud in a voice you pick. Text and voice share one memory.',
    limits: {
      servers: '10 servers',
      messages: '40,000 AI replies / mo',
      voice: '40 voice hours / mo',
      models: 'any OpenRouter model',
    },
    cta: 'Choose Voice',
  },
  {
    id: 'autonomy',
    name: 'Autonomy',
    tagline: 'He speaks up first.',
    price: 99,
    priceNote: 'per server, per month',
    blurb:
      'The pressure engine. He watches for blockers, wrong claims and dropped promises, and interjects once — when it actually helps.',
    limits: {
      servers: 'unlimited servers',
      messages: '150,000 AI replies / mo',
      voice: '200 voice hours / mo',
      models: 'any model + priority routing',
    },
    cta: 'Choose Autonomy',
  },
];

const TIER_INDEX = Object.fromEntries(TIERS.map((t, i) => [t.id, i]));

/* Every capability, grouped the way people think about them.
   `tier` is the lowest tier that includes it. `builder: true` means it
   shows up as a togglable module in the bot builder. */
const GROUPS = [
  {
    id: 'management',
    name: 'Server management',
    icon: '🛡️',
    summary: 'The unglamorous stuff, done properly and logged.',
    caps: [
      {
        id: 'mod-commands',
        name: 'Moderation commands',
        tier: 'hobby',
        builder: true,
        detail:
          'kick · ban · unban · timeout · untimeout · warn · warnings · clearwarnings · purge · slowmode · lock · unlock',
      },
      {
        id: 'roles-channels',
        name: 'Roles & channels',
        tier: 'hobby',
        builder: true,
        detail:
          'Create and delete roles and channels — text, voice, category, forum — and set topics, without leaving chat.',
      },
      {
        id: 'automod',
        name: 'Automod',
        tier: 'hobby',
        builder: true,
        detail:
          'Banned words, invite-link blocking and mention-spam limits. Pure pattern matching — no model in the path, nothing to be talked out of.',
      },
      {
        id: 'welcome',
        name: 'Welcome, goodbye & autorole',
        tier: 'hobby',
        builder: true,
        detail: 'Greet new members, say goodbye, and hand out a role on join.',
      },
      {
        id: 'modlog',
        name: 'Mod log & action history',
        tier: 'hobby',
        detail:
          'Every action lands in a channel you choose and is kept as a permanent, queryable record.',
      },
      {
        id: 'dashboard',
        name: 'Mobile dashboard',
        tier: 'hobby',
        detail:
          'Members, roles, channels, warnings, settings — built for a phone first, because that is where you actually are.',
      },
      {
        id: 'nl-admin',
        name: 'Plain-language admin',
        tier: 'core',
        builder: true,
        detail:
          'Tell him "give everyone in #build the shipper role and lock #announcements" and he does it. Owner only.',
      },
      {
        id: 'access-levels',
        name: 'Role-synced dashboard access',
        tier: 'core',
        detail:
          'Creator, admin and moderator levels read straight off your own Discord roles over the gateway — never off anything the browser sent. No second list of people to keep in step.',
      },
    ],
  },
  {
    id: 'conversation',
    name: 'Conversation',
    icon: '💬',
    summary: 'A bot with a personality, and the tools to back it up.',
    caps: [
      {
        id: 'chat',
        name: 'Mention & always-on channels',
        tier: 'hobby',
        builder: true,
        detail:
          '@mention him anywhere, or nominate channels where he replies to everything.',
      },
      {
        id: 'models',
        name: 'Full model catalog',
        tier: 'core',
        detail:
          'Any OpenRouter model ID, switchable per server from the dashboard. Frontier models for replies, a cheap pool for background work.',
      },
      {
        id: 'persona',
        name: 'Split persona',
        tier: 'core',
        builder: true,
        detail:
          'Character and capability are two separate prompts. You write who he is; we keep what he can do honest, so he never confidently claims a tool he does not have.',
      },
      {
        id: 'documents',
        name: 'Document reading',
        tier: 'core',
        builder: true,
        detail:
          'Drop a PDF, Word doc, markdown or source file on a message. He reads the contents, not the filename. No command needed.',
      },
      {
        id: 'search',
        name: 'Web search',
        tier: 'core',
        builder: true,
        detail: 'DuckDuckGo lookups folded into the answer, mid-conversation.',
      },
      {
        id: 'repo-analysis',
        name: 'GitHub repo analysis',
        tier: 'core',
        builder: true,
        detail:
          'Paste a repo link and he pulls stats, languages and the README, then actually discusses it.',
      },
      {
        id: 'repo-review',
        name: 'Repo review workspace',
        tier: 'autonomy',
        builder: true,
        detail:
          'Full read-only visibility into your own repo — every branch, contributor PRs with full diffs, branch comparisons, commits, files at any ref. Strictly read-only: merging stays a human decision.',
      },
    ],
  },
  {
    id: 'memory',
    name: 'Memory',
    icon: '🧠',
    summary: 'Rewritten after every single turn. No batching delay.',
    caps: [
      {
        id: 'working-memory',
        name: 'Working memory',
        tier: 'core',
        detail:
          'Current topic, open questions, and the recent turns that mattered — updated after every message, text or voice.',
      },
      {
        id: 'durable-memory',
        name: 'Durable memory',
        tier: 'core',
        builder: true,
        detail:
          'Dated facts, preferences and decisions, each with a confidence score, stored versioned in SQLite and injected into every reply.',
      },
      {
        id: 'profiles',
        name: 'Per-member profile cards',
        tier: 'core',
        detail:
          'Goals, active projects, constraints and vibe notes, per person — so he talks to your members like he knows them, because he does.',
      },
      {
        id: 'chat-log',
        name: 'Permanent searchable log',
        tier: 'core',
        detail:
          'Every raw turn is persisted before consolidation and kept forever. A redeploy mid-write replays instead of losing anything, and he can search the real log when a summary is not enough.',
      },
      {
        id: 'cross-channel',
        name: 'Cross-channel recall',
        tier: 'core',
        detail:
          'Every turn is tagged with where it happened. Say it in #general, ask about it in voice. He watches every channel, not just the ones he answers in.',
      },
      {
        id: 'knowledge',
        name: 'Knowledge base',
        tier: 'autonomy',
        builder: true,
        detail:
          'Procedural memory — reusable "how to do X" steps, server-wide. Before improvising an unfamiliar task he checks it; if nothing matches he asks instead of guessing, then saves the answer so nobody walks him through it twice.',
      },
      {
        id: 'manuscript',
        name: 'Manuscript',
        tier: 'autonomy',
        builder: true,
        detail:
          'Everything the owner says, voice or text, kept verbatim and never summarized. For the long-form material — a book draft, a life story — that must survive word for word.',
      },
    ],
  },
  {
    id: 'voice',
    name: 'Voice',
    icon: '🎙️',
    summary: 'In the channel, in the conversation.',
    caps: [
      {
        id: 'voice-join',
        name: 'Joins voice channels',
        tier: 'voice',
        builder: true,
        detail:
          'Speaks Discord’s DAVE end-to-end-encrypted voice protocol natively, in the same process as the bot. No sidecar, no second service.',
      },
      {
        id: 'transcription',
        name: 'Per-speaker transcription',
        tier: 'voice',
        builder: true,
        detail:
          'Every speaker arrives as their own stream and is transcribed separately in near-real-time. Blips too short or too quiet to be speech are dropped before they cost you anything.',
      },
      {
        id: 'wake',
        name: 'Wake phrases',
        tier: 'voice',
        builder: true,
        detail:
          'Whole phrases, not keywords — "hey max", "max, you around?". Capitals and punctuation ignored on both sides.',
      },
      {
        id: 'followup',
        name: 'Follow-up mode',
        tier: 'voice',
        builder: true,
        detail:
          'Say the wake phrase once. For the next 25 seconds anyone can just keep talking, and every real answer re-arms the window. "Max, stop speaking" cuts him off; "Max, stop listening" ends it.',
      },
      {
        id: 'tts',
        name: 'Neural TTS replies',
        tier: 'voice',
        builder: true,
        detail:
          'He answers out loud in an expressive neural voice, with the same memory and context he has in text.',
      },
      {
        id: 'voice-clone',
        name: 'Custom cloned voice',
        tier: 'voice',
        detail:
          'Bring your own fish.audio voice model reference and he speaks in it.',
      },
      {
        id: 'voice-automod',
        name: 'Voice automod',
        tier: 'voice',
        detail:
          'Banned words spoken out loud get flagged to the mod log the same as typed ones.',
      },
      {
        id: 'transcript-console',
        name: 'Live transcript console',
        tier: 'voice',
        detail: 'Watch the room from the dashboard, live, from your phone.',
      },
    ],
  },
  {
    id: 'initiative',
    name: 'Initiative',
    icon: '⚡',
    summary: 'The part no other bot does: speaking without being asked.',
    caps: [
      {
        id: 'pressure',
        name: 'Pressure engine',
        tier: 'autonomy',
        builder: true,
        detail:
          'Messages and transcripts are classified into typed signals — unresolved blockers, wrong technical claims, promised follow-ups, safety concerns. Each routes to its own reservoir that charges, decays and flows.',
      },
      {
        id: 'gate',
        name: 'The gate',
        tier: 'autonomy',
        detail:
          'Every drafted interjection is ruled on deterministically: thresholds, relevance, novelty, cooldowns, budgets, energy. Most drafts never get sent. That is the feature.',
      },
      {
        id: 'deescalation',
        name: 'De-escalation',
        tier: 'autonomy',
        detail:
          'He reads the temperature of a thread and stays out of heated exchanges rather than pouring a model into them.',
      },
      {
        id: 'proactive-voice',
        name: 'Proactive in voice too',
        tier: 'autonomy',
        builder: true,
        detail:
          'The same engine runs on voice transcripts, so he can speak up in the channel — once, deliberately, with something worth saying.',
      },
    ],
  },
  {
    id: 'ops',
    name: 'Operations',
    icon: '⚙️',
    summary: 'Because it has to stay up.',
    caps: [
      {
        id: 'state',
        name: 'Durable state',
        tier: 'hobby',
        detail:
          'Settings, warnings, logs and memory live on a persistent volume and survive every redeploy.',
      },
      {
        id: 'logs',
        name: 'Live logs & restart',
        tier: 'core',
        detail:
          'Stream the bot’s log and restart it from the dashboard when you need to.',
      },
      {
        id: 'breaker',
        name: 'Spend breaker',
        tier: 'core',
        detail:
          'A hard hourly cap on background model calls, so a runaway loop costs you a ceiling instead of a bill.',
      },
      {
        id: 'priority',
        name: 'Priority routing',
        tier: 'autonomy',
        detail: 'Your traffic goes first when providers are busy.',
      },
      {
        id: 'dedicated',
        name: 'Dedicated instance',
        tier: 'autonomy',
        detail:
          'Your own process and your own database file, not a shared pool.',
      },
    ],
  },
];

const ADDONS = [
  {
    id: 'extra-servers',
    name: 'Extra servers',
    price: '$8',
    unit: 'per server / mo',
    detail:
      'Past your plan’s included count. Each one gets its own settings, persona and memory.',
  },
  {
    id: 'voice-hours',
    name: 'Voice hour packs',
    price: '$12',
    unit: 'per 20 hours',
    detail:
      'Top up when a long session runs over. Rolls over for 90 days.',
  },
  {
    id: 'voice-model',
    name: 'Custom voice model',
    price: '$40',
    unit: 'one-time',
    detail:
      'We build and host a cloned voice from your samples and wire it to your bot.',
  },
  {
    id: 'byo-key',
    name: 'Bring your own key',
    price: '−$10',
    unit: 'per server / mo',
    detail:
      'Point him at your own OpenRouter key and pay us for the platform, not the tokens.',
  },
  {
    id: 'self-host',
    name: 'Self-host licence',
    price: 'Custom',
    unit: 'annual',
    detail:
      'The whole thing on your own Railway project or metal, with source access and upgrades.',
  },
];

const FAQ = [
  {
    q: 'Is this one bot everyone shares?',
    a: 'No. Every subscription provisions its own bot application, its own token and its own database file. Your persona, your memory and your logs are yours — nothing is pooled with another server.',
  },
  {
    q: 'What happens if I cancel?',
    a: 'The bot stops replying at the end of the billing period and stays in your server, muted, for 30 days. Export your memory, manuscript and full chat log at any point during that window. After 30 days the database is deleted.',
  },
  {
    q: 'Do I need an OpenRouter account?',
    a: 'Not unless you want one. Model spend is included in every paid tier up to the reply limits. If you would rather run on your own key, bring it and take $10 off per server per month.',
  },
  {
    q: 'How is voice end-to-end encrypted audio handled?',
    a: 'He speaks Discord’s DAVE protocol natively, in the same process as the bot. Audio is decrypted, transcribed and discarded; only the transcript is stored, and only if you have transcript retention on.',
  },
  {
    q: 'Will he spam my server if I turn on Autonomy?',
    a: 'That is the exact failure the gate exists to prevent. Pressure has to clear a per-signal threshold, then pass relevance, novelty, cooldown, budget and energy checks before a single word is sent. Most drafted interjections are discarded. You can watch the whole thing live and turn it off with one command.',
  },
  {
    q: 'Can I change tiers later?',
    a: 'Any time, both directions. Upgrades take effect on the next message; downgrades at the end of the period. Nothing is deleted when you downgrade — capabilities above your tier just stop running until you come back.',
  },
];

/* Plain script, not an ES module, so the site also opens straight off the
   filesystem without a server in front of it. */
window.CATALOG = { TIERS, TIER_INDEX, GROUPS, ADDONS, FAQ };
