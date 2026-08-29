/* The platform model: venues, credit pricing, provisioning state, and the
   API client the onboarding form, customer dashboard and staff queue all
   share.

   Every screen goes through `API` and no screen calls fetch directly, which
   is the same containment the demo store had — it is just talking to the bot
   now instead of to localStorage.

   The pricing and pipeline constants below are a COPY of what the backend
   owns (`nodebot/src/credits/rates.js` and `nodebot/src/platform/`). They
   exist so the marketing pages render instantly and still render with the
   backend down. `API.catalog()` overwrites them with the live values on load,
   and nodebot's test suite fails if the two ever disagree — a price shown
   here that is not the price charged is the worst kind of bug to hear about
   from a customer. */

/* ── Service venues ─────────────────────────────────────────────────────── */

const VENUES = [
  {
    id: 'managed',
    name: 'Managed',
    tagline: 'We supply the keys. You buy credits.',
    detail:
      'We hold the OpenRouter and voice provider accounts, meter what your bot '
      + 'actually uses, and bill it against a credit balance you top up. Nothing '
      + 'to sign up for elsewhere, and no provider bill of your own.',
    forWho: 'Almost everyone. Communities, servers, small teams.',
    billing: 'Subscription tier + usage credits',
    setup: 'We build it with you — a session, not a signup form',
  },
  {
    id: 'enterprise',
    name: 'Enterprise (bring your own keys)',
    tagline: 'Your provider accounts. We run the platform.',
    detail:
      'You hold the provider contracts and the spend sits on your own accounts. '
      + 'We handle provisioning, the dashboard, upgrades and support, including '
      + 'the install. Usage is reported back to you but never billed by us.',
    forWho: 'Orgs with procurement, existing provider contracts, or data rules.',
    billing: 'Flat platform fee per server',
    setup: 'Assisted — key handover and a call',
  },
];

/* ── Credit model ───────────────────────────────────────────────────────────

   One credit is one cent of list price. Rates are what we charge, already
   inclusive of margin over provider cost — the dashboard never shows a
   customer a raw provider price.

   `integrated: false` means the platform can price it but the bot cannot use
   it yet. It is shown greyed rather than hidden, because the honest answer to
   "do you support ElevenLabs" is "priced, not wired up". */

let CREDIT_RATES = [
  {
    id: 'reply-standard',
    provider: 'OpenRouter',
    name: 'AI reply — standard model',
    credits: 2,
    unit: 'per reply',
    integrated: true,
    note: 'Haiku-class. The default for chat.',
  },
  {
    id: 'reply-frontier',
    provider: 'OpenRouter',
    name: 'AI reply — frontier model',
    credits: 8,
    unit: 'per reply',
    integrated: true,
    note: 'Opus/Sonnet-class, when a server picks one.',
  },
  {
    id: 'background',
    provider: 'OpenRouter',
    name: 'Background work',
    credits: 0.2,
    unit: 'per call',
    integrated: true,
    note: 'Memory upkeep, signal classification, de-escalation. ~85% of call volume.',
  },
  {
    id: 'transcription',
    provider: 'OpenAI / Groq',
    name: 'Voice transcription',
    credits: 6,
    unit: 'per minute',
    integrated: true,
    note: 'Per speaker. Silence and noise blips are dropped before they bill.',
  },
  {
    id: 'tts-fish',
    provider: 'Fish Audio',
    name: 'Spoken reply — Fish Audio',
    credits: 4,
    unit: 'per minute',
    integrated: true,
    note: 'The default voice. edge-tts is the free fallback and bills nothing.',
  },
  {
    id: 'tts-eleven',
    provider: 'ElevenLabs',
    name: 'Spoken reply — ElevenLabs',
    credits: 12,
    unit: 'per minute',
    integrated: false,
    note: 'Priced and ready to meter. Not yet wired into the bot — see the roadmap.',
  },
  {
    id: 'music-clip',
    provider: 'OpenRouter',
    name: 'Music — short clip',
    credits: 15,
    unit: 'per clip',
    integrated: true,
    note: 'Lyria, ~30 seconds. Metered per generation, whether or not it is kept.',
  },
  {
    id: 'music-song',
    provider: 'OpenRouter',
    name: 'Music — full song',
    credits: 45,
    unit: 'per song',
    integrated: true,
    note: 'Lyria, full structured track. Metered per generation, whether or not it is kept.',
  },
];

/* Top-up packs. Bigger packs are cheaper per credit; that discount is the
   only lever that makes prepayment worth anything to the customer.

   There is no checkout behind these yet. They are the price list we quote
   from: you pay us however we agreed, and we put the credits on the account
   against that payment reference. */
let CREDIT_PACKS = [
  { id: 'pack-10', credits: 5000, price: 10 },
  { id: 'pack-50', credits: 30000, price: 50, popular: true },
  { id: 'pack-100', credits: 75000, price: 100 },
  { id: 'pack-240', credits: 200000, price: 240 },
];

/** Discount vs. the smallest pack's per-credit rate. */
function packSavingPct(pack) {
  const base = CREDIT_PACKS[0].price / CREDIT_PACKS[0].credits;
  const rate = pack.price / pack.credits;
  return Math.round((1 - rate / base) * 100);
}

/* ── Provisioning ──────────────────────────────────────────────────────────

   A submitted order walks this pipeline. `auto: true` steps run without a
   human. Everything from review on is moved by a person — that is not a gap,
   it is the product: somebody here sits down with the customer and builds the
   bot with them. */

let PIPELINE = [
  {
    id: 'submitted',
    name: 'Submitted',
    auto: true,
    detail: 'Order received, plan and capabilities recorded.',
  },
  {
    id: 'validated',
    name: 'Validated',
    auto: true,
    detail: 'Capability set checked against the tier; impossible combinations rejected.',
  },
  {
    id: 'review',
    name: 'Review',
    auto: false,
    detail: 'We get in a room with you and build it out together. '
      + 'Enterprise key handover happens here.',
  },
  {
    id: 'provisioning',
    name: 'Provisioning',
    auto: false,
    detail: 'Discord application registered, token minted, settings written.',
  },
  {
    id: 'ready',
    name: 'Ready',
    auto: false,
    detail: 'Invite link issued and dashboard access granted.',
  },
];

let PIPELINE_INDEX = Object.fromEntries(PIPELINE.map((s, i) => [s.id, i]));

/** Which orders need a human, and why. Drives the staff queue's filter. */
function needsHuman(request) {
  if (request.stage === 'rejected' || request.stage === 'ready') return null;
  if (request.venue === 'enterprise') return 'Key handover and contract';
  if (request.stage === 'review') return 'Capability set confirmation';
  if (request.stage === 'validated') return 'Ready to schedule the build session';
  if (request.stage === 'submitted') return 'Capability set does not validate';
  return 'Provisioning in progress';
}

/* ── API client ─────────────────────────────────────────────────────────────

   The bot serves both this site and these endpoints, so requests are
   same-origin and the session cookie rides along on its own. */

class ApiError extends Error {
  constructor(status, detail) {
    super(detail || `Request failed (${status})`);
    this.status = status;
    this.detail = detail;
  }
}

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch (err) {
    // The site can be opened straight off the filesystem, where there is no
    // backend at all. Saying so beats a stack trace in the console.
    throw new ApiError(0, 'Could not reach the server.');
  }
  let data = null;
  try { data = await res.json(); } catch (err) { /* empty body is fine */ }
  if (!res.ok) throw new ApiError(res.status, data && data.detail);
  return data;
}

const API = {
  ApiError,

  /** Live pricing, tiers and pipeline. Overwrites the static copies above so
   *  every screen renders the real numbers once this resolves. */
  async catalog() {
    const data = await request('GET', '/api/platform/catalog');
    if (data.rates) CREDIT_RATES = data.rates;
    if (data.packs) CREDIT_PACKS = data.packs;
    if (data.stages) {
      PIPELINE = data.stages;
      PIPELINE_INDEX = Object.fromEntries(PIPELINE.map((s, i) => [s.id, i]));
    }
    return data;
  },

  signUp: (payload) => request('POST', '/api/platform/signup', payload),
  signIn: (email, password) => request('POST', '/api/platform/signin', { email, password }),
  signOut: () => request('POST', '/api/platform/signout', {}),

  /** The signed-in account with its servers and balance, or null. */
  async me() {
    try {
      return await request('GET', '/api/platform/me');
    } catch (err) {
      if (err.status === 401) return null;
      throw err;
    }
  },

  usage: (days = 30) => request('GET', `/api/platform/usage?days=${days}`),
  grants: () => request('GET', '/api/platform/grants'),
  myOrders: () => request('GET', '/api/platform/orders'),
  setAutoTopUp: (config) => request('PUT', '/api/platform/autotopup', config),

  submitOrder: (order) => request('POST', '/api/platform/orders', order),
  validateOrder: (tier, modules) => request('POST', '/api/platform/orders/validate', { tier, modules }),

  /* staff */
  queue: (stage) => request('GET', `/api/platform/admin/requests${stage ? `?stage=${stage}` : ''}`),
  updateRequest: (id, patch) => request('PUT', `/api/platform/admin/requests/${id}`, patch),
  advance: (id, stage) => request('POST', `/api/platform/admin/requests/${id}/advance`, { stage }),
  approve: (id, accountId) => request('POST', `/api/platform/admin/requests/${id}/approve`, { accountId }),
  accounts: () => request('GET', '/api/platform/admin/accounts'),
  account: (id) => request('GET', `/api/platform/admin/accounts/${id}`),
  issueCredits: (id, payload) => request('POST', `/api/platform/admin/accounts/${id}/credits`, payload),
  attachGuild: (serverId, guildId) => request('POST', `/api/platform/admin/servers/${serverId}/guild`, { guildId }),
  setServerStatus: (serverId, status) => request('POST', `/api/platform/admin/servers/${serverId}/status`, { status }),
};

/* ── Derived numbers ────────────────────────────────────────────────────── */

/** Mean daily spend over the last `days` days of a usage rollup. */
function burnRate(daily, days = 7) {
  if (!daily || !daily.length) return 0;
  const window = daily.slice(-days);
  return window.reduce((sum, row) => sum + (row.credits || 0), 0) / window.length;
}

/** Whole days of balance left at the current burn rate. Infinity if idle. */
function daysRemaining(credits, daily) {
  const rate = burnRate(daily);
  if (rate <= 0) return Infinity;
  return Math.floor(credits / rate);
}

/** Credits grouped by provider, for the usage breakdown. Takes the `byKind`
 *  rollup the API returns and folds it up through the rate card, so a new
 *  billable line appears here without this function knowing about it. */
function usageByProvider(byKind) {
  const totals = {};
  for (const row of byKind || []) {
    const rate = CREDIT_RATES.find((r) => r.id === row.kind);
    const name = rate ? rate.provider : 'Other';
    totals[name] = (totals[name] || 0) + row.credits;
  }
  return totals;
}

const fmt = {
  credits: (n) => Math.round(n).toLocaleString('en-US'),
  money: (n) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
  compact: (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(Math.round(n))),
  when: (ts) => {
    if (!ts) return '—';
    const mins = Math.round((Date.now() - ts) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 48) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  },
};

window.PLATFORM = {
  VENUES,
  get CREDIT_RATES() { return CREDIT_RATES; },
  get CREDIT_PACKS() { return CREDIT_PACKS; },
  get PIPELINE() { return PIPELINE; },
  get PIPELINE_INDEX() { return PIPELINE_INDEX; },
  packSavingPct,
  needsHuman,
  API,
  burnRate,
  daysRemaining,
  usageByProvider,
  fmt,
};
