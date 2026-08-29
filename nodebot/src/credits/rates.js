// The rate card and top-up packs — what we charge, and what a pack costs.
//
// This module is the source of truth for pricing. `site/js/platform.js` holds
// a copy for the marketing pages to render before they've talked to the API;
// test/credits.test.js asserts the two agree, so the copy cannot drift.
//
// ── Why millicredits ────────────────────────────────────────────────────────
//
// One credit is one cent of list price, and the customer only ever sees
// credits. Internally every amount is an integer count of THOUSANDTHS of a
// credit ("milli"), because the rate card has a sub-credit rate in it:
// background work is 0.2 credits per call, and the rate card itself notes
// that background work is ~85% of all call volume.
//
// Deducting 0.2 from an integer balance truncates to zero, which would make
// the large majority of what the platform actually spends money on free. And
// a float balance accumulates drift over the hundreds of thousands of small
// writes this thing is built to take. Integer millicredits are exact, and
// SQLite's INTEGER is 64-bit — the largest pack is 2×10^8 milli, so there is
// no headroom problem.
//
// Convention: any variable holding milli is named `...Milli`. Anything named
// `credits` is customer-facing and may be fractional.

/** Thousandths of a credit per credit. */
export const MILLI = 1000;

export const toMilli = (credits) => Math.round(credits * MILLI);
export const toCredits = (milli) => milli / MILLI;

/* Rates are list price, already inclusive of margin over provider cost — a
   customer is never shown a raw provider price.

   `integrated: false` means the platform can price it but the bot cannot use
   it yet. Shown greyed rather than hidden, because the honest answer to "do
   you support ElevenLabs" is "priced, not wired up". */
export const CREDIT_RATES = [
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

/** The billable kind for one generate_music call. */
export function musicKind(length) {
  return length === 'full' ? 'music-song' : 'music-clip';
}

const RATE_BY_ID = new Map(CREDIT_RATES.map((r) => [r.id, r]));

/** @returns {object} the rate card entry. Throws on an unknown kind, rather
 *  than billing zero for a typo and losing the revenue silently. */
export function rateFor(kind) {
  const rate = RATE_BY_ID.get(kind);
  if (!rate) throw new Error(`unknown billable kind: ${kind}`);
  return rate;
}

/** Millicredits for `quantity` units of `kind`, rounded to the nearest milli. */
export function costMilli(kind, quantity = 1) {
  return Math.round(toMilli(rateFor(kind).credits) * quantity);
}

/* Top-up packs. Bigger packs are cheaper per credit; that discount is the
   only lever that makes prepayment worth anything to the customer.

   `price` is US dollars. There is no checkout behind these yet — a customer
   pays out of band and staff issue the credits by hand (see ledger.issue).
   The packs still matter: they are the price list we quote from, and issuing
   against a pack id records WHAT was sold, not just a number. */
export const CREDIT_PACKS = [
  { id: 'pack-10', credits: 5000, price: 10 },
  { id: 'pack-50', credits: 30000, price: 50, popular: true },
  { id: 'pack-100', credits: 75000, price: 100 },
  { id: 'pack-240', credits: 200000, price: 240 },
];

const PACK_BY_ID = new Map(CREDIT_PACKS.map((p) => [p.id, p]));

export function packById(id) {
  return PACK_BY_ID.get(id) || null;
}

/** Discount vs. the smallest pack's per-credit rate. */
export function packSavingPct(pack) {
  const base = CREDIT_PACKS[0].price / CREDIT_PACKS[0].credits;
  const rate = pack.price / pack.credits;
  return Math.round((1 - rate / base) * 100);
}

/* ── Which reply rate a model bills at ──────────────────────────────────────

   The rate card sells two reply tiers, "Haiku-class" and "Opus/Sonnet-class".
   A server can point `ai_model` at any OpenRouter model id, so this has to
   decide which tier an arbitrary id falls into.

   Matching is on substrings of the model id and deliberately errs toward
   `reply-standard`: an unrecognised model bills at the cheap rate. Getting
   that backwards would overcharge a customer for a model we failed to
   recognise, which is far worse than under-billing one we did. New frontier
   families go here as they ship. */
const FRONTIER_PATTERNS = [
  'opus', 'sonnet', 'gpt-4o', 'gpt-4.1', 'gpt-4-turbo', 'gpt-5', 'o1-', 'o3-',
  'gemini-2.5-pro', 'gemini-1.5-pro', 'gemini-3-pro', 'grok-4', 'deepseek-r1',
  'llama-3.1-405b', 'mistral-large', 'command-a', 'qwen3-max',
];

/** @returns {'reply-frontier'|'reply-standard'} */
export function replyKindForModel(model) {
  const id = String(model || '').toLowerCase();
  return FRONTIER_PATTERNS.some((p) => id.includes(p)) ? 'reply-frontier' : 'reply-standard';
}

/**
 * The billable kind for one `chat()` call.
 *
 * Background work bills a flat per-call rate whatever model served it — the
 * utility model is already the cheap one by construction, and the rate card
 * sells "background work" as one line rather than exposing which model ran.
 */
export function chatKind({ model, background }) {
  return background ? 'background' : replyKindForModel(model);
}
