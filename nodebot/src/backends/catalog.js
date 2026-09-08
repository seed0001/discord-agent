// OpenRouter's model list, refreshed on a timer and cached locally.
//
// The point is to know what she can switch TO when the current backend starts
// refusing. That answer changes — models appear, get deprecated, and change
// price — so it is fetched rather than hard-coded, and cached in SQLite so a
// restart or an OpenRouter outage doesn't leave her with no alternatives at
// the exact moment she needs one.
//
// The endpoint is public: no API key, and it is safe to call without spending
// anything. Only a distilled row per model is kept — the full response is
// ~400 models of prose and provider metadata, and the only things that matter
// for picking a fallback are what it costs, how much context it has, and
// whether it can do tool calling.
import { getDb } from '../db.js';

const MODELS_URL = 'https://openrouter.ai/api/v1/models';

/** How long a cached catalog stays usable before a refresh is attempted. */
export const REFRESH_INTERVAL_MS = 3600_000;
/** Past this, the catalog is too old to pick a fallback from confidently. It
 *  is still used — a stale list beats no list when the backend is down — but
 *  it is logged, because silently routing to a model that was deprecated a
 *  week ago is the kind of failure that wastes an afternoon. */
export const STALE_AFTER_MS = 24 * 3600_000;

const now = () => Math.floor(Date.now() / 1000);

/**
 * Distil one OpenRouter model entry to the fields a fallback decision needs.
 *
 * `pricing.prompt` / `pricing.completion` are per-token USD as decimal
 * strings. They are stored per MILLION tokens, which is the unit everything
 * else quotes and avoids carrying numbers like 0.0000008 around.
 */
/**
 * Can this model be used for chat completions at all?
 *
 * OpenRouter's catalog is not a list of chat models — it is a list of
 * *models*. Image generators, video generators, embedding models and music
 * generators are all in there, and asking one of them for a chat completion
 * returns a 502 "Provider returned error" rather than a clean rejection:
 *
 *   [proactive] signal classification failed: OpenRouter error 502
 *     (google/lyria-3-clip-preview, background): Provider returned error
 *
 * `google/lyria-3-clip-preview` is a music generator. It will never answer a
 * classification prompt no matter how many times it is retried, so the filter
 * has to happen here, before it can ever be picked as a fallback.
 *
 * Prefers the explicit modality arrays and falls back to parsing the older
 * `modality` string ("text->text", "text+image->text") for entries that
 * predate them.
 */
export function canChat(entry) {
  const arch = entry?.architecture || {};
  const inputs = arch.input_modalities;
  const outputs = arch.output_modalities;
  if (Array.isArray(inputs) && Array.isArray(outputs)) {
    // Output must be TEXT ONLY. A model that also lists 'audio' or 'image'
    // among its outputs — Lyria, an image generator — answers a chat
    // completions request in its own way, not in prose, and is unusable for
    // background text work even though 'text' is technically one of the
    // modalities it claims. This is the bug that let a music generator get
    // picked as the background model in the first place (see evictUnusable).
    return inputs.includes('text') && outputs.length > 0 && outputs.every((m) => m === 'text');
  }
  const modality = String(arch.modality || '');
  if (!modality.includes('->')) return false; // unknown shape — do not guess
  const [from, to] = modality.split('->');
  return from.includes('text') && to.trim() === 'text';
}

export function distil(entry) {
  if (!entry?.id) return null;
  const params = entry.supported_parameters || [];
  const perMillion = (v) => {
    const n = Number.parseFloat(v);
    if (!Number.isFinite(n)) return null;
    // Rounded because binary floating point does not survive the scale-up:
    // 0.0000008 * 1e6 is 0.7999999999999999, and "$0.7999999999999999 per
    // million tokens" is not a thing to show anybody. Six places is far
    // finer than any real per-million price.
    return Math.round(n * 1e6 * 1e6) / 1e6;
  };
  return {
    id: String(entry.id),
    name: String(entry.name || entry.id),
    contextLength: Number.parseInt(entry.context_length, 10) || null,
    promptPrice: perMillion(entry.pricing?.prompt),
    completionPrice: perMillion(entry.pricing?.completion),
    // Tool calling is the one hard capability requirement for the
    // conversational model — she has ~30 tools and degrades badly without
    // them. Background work does not care.
    supportsTools: params.includes('tools'),
    // Whether it can hold a text conversation at all. See canChat().
    canChat: canChat(entry),
  };
}

/** Fetch and store the catalog. Returns the number of models stored.
 *
 * Never throws: a failed refresh leaves the previous catalog in place, which
 * is the right outcome. This runs on a timer with nobody watching. */
export async function refresh({ fetchImpl = fetch } = {}) {
  let entries;
  try {
    const resp = await fetchImpl(MODELS_URL, { headers: { Accept: 'application/json' } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const body = await resp.json();
    entries = body?.data;
    if (!Array.isArray(entries)) throw new Error('no data array in response');
  } catch (err) {
    console.warn('[backends] model catalog refresh failed:', err.message);
    return 0;
  }

  const rows = entries.map(distil).filter(Boolean);
  if (!rows.length) {
    console.warn('[backends] model catalog came back empty — keeping the old one');
    return 0;
  }

  const db = getDb();
  const stamp = now();
  db.exec('BEGIN IMMEDIATE');
  try {
    // Replace wholesale rather than upsert: a model that vanished from
    // OpenRouter must vanish here too, or she will keep offering it.
    db.prepare('DELETE FROM model_catalog').run();
    const insert = db.prepare(`
      INSERT INTO model_catalog
        (id, name, context_length, prompt_price, completion_price,
         supports_tools, can_chat, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows) {
      insert.run(row.id, row.name, row.contextLength, row.promptPrice,
        row.completionPrice, row.supportsTools ? 1 : 0, row.canChat ? 1 : 0, stamp);
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    console.warn('[backends] could not store model catalog:', err.message);
    return 0;
  }
  console.log(`[backends] model catalog refreshed — ${rows.length} models`);
  return rows.length;
}

function hydrate(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    contextLength: row.context_length,
    promptPrice: row.prompt_price,
    completionPrice: row.completion_price,
    supportsTools: Boolean(row.supports_tools),
    canChat: Boolean(row.can_chat),
    fetchedAt: row.fetched_at * 1000,
  };
}

/**
 * Smallest context window worth routing to.
 *
 * Memory consolidation alone asks for 4096 output tokens on top of durable
 * memory, working memory, member profiles and a batch of turns. A model with a
 * tiny window cannot do that job, and finding out costs a failed call and a
 * lost consolidation rather than a clean rejection.
 */
export const MIN_CONTEXT_TOKENS = 16000;

export function get(modelId) {
  if (!modelId) return null;
  try {
    return hydrate(getDb().prepare('SELECT * FROM model_catalog WHERE id = ?').get(String(modelId)));
  } catch {
    return null; // database not up — treated as "unknown model", never fatal
  }
}

/**
 * Models that are actually usable as a backend.
 *
 * Filtered, not raw: anything that cannot hold a text conversation, or whose
 * context window is too small to do the work, is excluded — routing to one of
 * those produces a 502 and a lost call rather than an answer. Pass
 * `usable: false` to see the unfiltered cache.
 */
export function list({ toolsOnly = false, usable = true } = {}) {
  const where = [];
  if (toolsOnly) where.push('supports_tools = 1');
  if (usable) {
    where.push('can_chat = 1');
    where.push(`(context_length IS NULL OR context_length >= ${MIN_CONTEXT_TOKENS})`);
  }
  try {
    const sql = `SELECT * FROM model_catalog${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`;
    return getDb().prepare(sql).all().map(hydrate);
  } catch {
    return [];
  }
}

/** When the catalog was last successfully fetched, or null if never. */
export function fetchedAt() {
  try {
    const row = getDb().prepare('SELECT MAX(fetched_at) AS at FROM model_catalog').get();
    return row?.at ? row.at * 1000 : null;
  } catch {
    return null;
  }
}

export function isEmpty() {
  return fetchedAt() === null;
}

export function isStale(nowMs = Date.now()) {
  const at = fetchedAt();
  return at === null || nowMs - at > STALE_AFTER_MS;
}

/** True when a model costs nothing to call. Free models are the ones with
 *  hard daily request caps, which is why they need singling out. */
export function isFree(model) {
  return Boolean(model) && model.promptPrice === 0 && model.completionPrice === 0;
}

let timer = null;

/**
 * Start the hourly refresh. Fetches once immediately if the catalog is empty,
 * so a fresh install has alternatives available before the first rate limit
 * rather than an hour after it.
 *
 * `afterRefresh` runs after each successful fetch. It exists so switching can
 * re-check the stored models against a catalog it could not consult before —
 * calling into switching from here directly would be a circular import, since
 * switching is built on top of this module.
 */
export function startRefreshing({ intervalMs = REFRESH_INTERVAL_MS, afterRefresh } = {}) {
  if (timer) return timer;
  const run = async () => {
    const stored = await refresh();
    if (stored && afterRefresh) {
      try { afterRefresh(); } catch (err) {
        console.warn('[backends] post-refresh check failed:', err.message);
      }
    }
  };
  // Always once on boot, not just when the cache is empty: a fix to what
  // counts as "can hold a text conversation" (canChat) only takes effect
  // against freshly re-classified data, and a bad model stuck as the
  // background one from before that fix stays stuck for up to intervalMs
  // otherwise — see evictUnusable, which this feeds. Cheap and unauthenticated
  // either way, so there's no real cost to not waiting for staleness.
  run();
  timer = setInterval(run, intervalMs);
  timer.unref?.(); // never hold the process open for a catalog refresh
  return timer;
}

export function stopRefreshing() {
  if (timer) clearInterval(timer);
  timer = null;
}
