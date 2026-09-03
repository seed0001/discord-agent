// OpenRouter chat-completions client, with tool-calling — ported from
// openrouter.py's agent loop, including the background spend-cap breaker
// and the free-pool junk-verdict re-roll.
import {
  OPENROUTER_API_KEY, OPENROUTER_MODEL,
  OPENROUTER_UTILITY_MODEL, OPENROUTER_BG_HOURLY_CAP,
} from './config.js';
import * as credits from './credits/index.js';
import * as switching from './backends/switching.js';

const API_URL = 'https://openrouter.ai/api/v1/chat/completions';

export class OpenRouterError extends Error {}

// Timestamps of background calls in the last hour, for the spend breaker.
const bgCalls = [];

/** Throws once background calls exceed the hourly cap. */
function bgBudgetCheck() {
  const cap = OPENROUTER_BG_HOURLY_CAP;
  if (cap <= 0) return;
  const now = Date.now();
  while (bgCalls.length && now - bgCalls[0] > 3600_000) bgCalls.shift();
  if (bgCalls.length >= cap) {
    throw new OpenRouterError(`background call budget exhausted (${cap}/hour) — skipping`);
  }
  bgCalls.push(now);
}

/**
 * Background calls still available this hour (Infinity when uncapped).
 *
 * Exists so a high-frequency caller can leave headroom for the low-frequency
 * ones instead of racing them for a shared pool. Voice mention detection can
 * fire on every utterance in a busy channel; memory consolidation runs
 * occasionally but matters far more, and it lost that race — the whole budget
 * went to detection and consolidation, de-escalation and proactive
 * classification all started failing at once.
 *
 * Read-only: unlike bgBudgetCheck this does not consume a slot.
 */
export function bgBudgetRemaining(now = Date.now()) {
  const cap = OPENROUTER_BG_HOURLY_CAP;
  if (cap <= 0) return Infinity;
  while (bgCalls.length && now - bgCalls[0] > 3600_000) bgCalls.shift();
  return Math.max(0, cap - bgCalls.length);
}

// One model in the free pool answers everything with a bare safety verdict
// ("user safety safe"). Detect that and re-roll so the free router picks a
// different model, rather than passing the junk through as Max's reply.
const JUNK_VERDICT_RE = /^\W*(user\s*safety\W*)?(safe|unsafe)\W*$/i;
const JUNK_RETRIES = 2;

function isJunkVerdict(content) {
  const text = (content || '').trim();
  return text.length < 40 && JUNK_VERDICT_RE.test(text);
}

// Some models (seen: MiniMax M2 via OpenRouter, no repetition penalty sent —
// see the chat() payload below) occasionally finish a normal reply and then
// spiral into repeating one short token or character until max_tokens cuts
// them off, e.g. a real sentence followed by hundreds of "] ] ] ] ]...".
// Neither a real HTTP error nor a short junk verdict, so nothing else here
// catches it — without this it goes straight out as the reply. Checked only
// near the tail: an intentional repeated character earlier in a real reply
// (a run of "!" for emphasis, ASCII art) shouldn't trigger a re-roll.
const REPEAT_RUN_MIN = 20;
function hasDegenerateRepetition(content) {
  const text = content || '';
  const tail = text.slice(-400);
  if (/(.)\1{39,}/.test(tail)) return true;
  const tokens = tail.trim().split(/\s+/);
  if (tokens.length < REPEAT_RUN_MIN) return false;
  const last = tokens[tokens.length - 1];
  let run = 0;
  for (let i = tokens.length - 1; i >= 0 && tokens[i] === last; i -= 1) run += 1;
  return run >= REPEAT_RUN_MIN;
}

const RETRYABLE_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;              // additional attempts, foreground only
const BASE_BACKOFF_MS = 700;
const MAX_BACKOFF_MS = 8_000;

/** Signals "this model can't do tool calling" so the caller can re-run the
 * same round without tools. Internal — never escapes chat(). */
class ToolUnsupportedError extends Error {}

/** Signals "this model can't accept images" so the caller can re-run the
 * same round with the image parts stripped. Internal — never escapes chat(). */
class ImageUnsupportedError extends Error {}

/** True when any message carries OpenAI-style multimodal content (an array of
 * parts) rather than a plain string. */
function hasImageParts(messages) {
  return (messages || []).some((m) => Array.isArray(m?.content));
}

/**
 * Flattens multimodal messages down to text: any message whose `content` is an
 * array of parts becomes a plain string joining the `type === 'text'` parts,
 * dropping everything else (images). Messages already holding a string — or
 * null, as tool-calling assistant turns do — are passed through untouched.
 *
 * Nothing is mutated: new message objects are built and the input array is
 * left alone, because the caller may still need the original to retry against
 * a different model.
 *
 * @param {Array} messages
 * @returns {{messages: Array, changed: boolean}} changed is false when there
 *   was no multimodal content to strip — the signal that retrying is pointless.
 */
export function stripImageParts(messages) {
  let changed = false;
  const out = (messages || []).map((m) => {
    if (!Array.isArray(m?.content)) return m;
    changed = true;
    const text = m.content
      .filter((part) => part?.type === 'text')
      .map((part) => part.text || '')
      .join('\n');
    return { ...m, content: text };
  });
  return { messages: out, changed };
}

/**
 * OpenRouter reports an upstream provider failure in TWO different shapes: a
 * real HTTP error, and — the one that actually bit us — HTTP 200 with an
 * error object in the body:
 *
 *   {"error":{"message":"Provider returned error","code":429}}
 *
 * Checking resp.ok alone misses that entirely. A plain rate limit fell
 * through to the `!reply` branch and surfaced as "Unexpected OpenRouter
 * response", which reads like a protocol bug, and was never retried.
 *
 * @returns {{status: number, message: string}|null} null when genuinely fine.
 */
export function readError(resp, data, text) {
  const bodyCode = Number.parseInt(data?.error?.code, 10);
  let status = 0;
  if (!resp.ok) status = resp.status;
  else if (Number.isFinite(bodyCode) && bodyCode >= 400) status = bodyCode;
  else if (data?.error) status = 502; // an error with no usable code
  if (!status) return null;
  return {
    status,
    message: data?.error?.message || String(text || '').slice(0, 300) || `HTTP ${status}`,
  };
}

/** Exponential backoff with jitter, but honour Retry-After when given. */
export function backoffMs(attempt, retryAfter, rand = Math.random) {
  const secs = Number.parseInt(retryAfter, 10);
  if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1000, MAX_BACKOFF_MS);
  const base = Math.min(BASE_BACKOFF_MS * (2 ** (attempt - 1)), MAX_BACKOFF_MS);
  return base + Math.floor(rand() * 250);
}

function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener?.('abort', () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }, { once: true });
  });
}

async function requestCompletion(payload, signal, background) {
  // Background work gets exactly one shot. It is best-effort by definition,
  // and retrying it would have it compete with the conversation for the same
  // rate limit — making a 429 more likely for the reply somebody is actually
  // sitting there waiting on. The hourly budget breaker already caps it.
  const attempts = background ? 1 : MAX_RETRIES + 1;
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const resp = await fetch(API_URL, {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'X-Title': 'Discord Agent',
      },
      body: JSON.stringify(payload),
    });
    // eslint-disable-next-line no-await-in-loop
    const text = await resp.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch { /* non-JSON body — readError falls back to the raw text */ }

    const err = readError(resp, data, text);
    if (!err) return data;

    // Free-pool (and some budget) models don't support tool calling. Not a
    // failure — the caller retries the round without tools.
    if (payload.tools && [400, 404].includes(err.status)
        && err.message.toLowerCase().includes('tool')) {
      throw new ToolUnsupportedError(err.message);
    }

    // Same story for image input: most models are text-only (the whole free
    // pool is) and reject a multimodal message outright rather than ignoring
    // the picture. The caller retries with the image parts stripped. Gate on
    // the payload actually carrying images — otherwise an unrelated failure
    // whose message merely happens to say "image" would send us into a retry
    // that changes nothing.
    if ([400, 404, 415].includes(err.status)
        && /image|vision|modalit|multimodal/i.test(err.message)
        && hasImageParts(payload.messages)) {
      throw new ImageUnsupportedError(err.message);
    }

    last = err;
    if (!RETRYABLE_STATUSES.has(err.status) || attempt === attempts) break;
    const wait = backoffMs(attempt, resp.headers?.get?.('retry-after'));
    console.warn(`[openrouter] ${err.status} from ${payload.model} — `
      + `retrying in ${wait}ms (attempt ${attempt}/${attempts - 1})`);
    // eslint-disable-next-line no-await-in-loop
    await sleep(wait, signal);
  }
  const label = last.status === 429 ? 'rate limited' : `error ${last.status}`;
  // Park a rate-limited backend so the fallback picker stops offering it. Done
  // here rather than at the call sites because this is the one place that
  // knows both which model was asked and what the provider said back — the
  // message is what distinguishes a per-minute burst limit from a daily quota,
  // and those need very different cooldowns.
  if (last.status === 429) {
    switching.markUnavailable(payload.model, { reason: last.message });
  } else if (last.status >= 500) {
    // An upstream failure. Usually transient, but it is also what a model
    // that can never answer us looks like — asking a music generator for a
    // chat completion returns 502 "Provider returned error", not a clean
    // rejection. Park it briefly either way: a good model comes back in five
    // minutes, and a fundamentally wrong one stops being picked every time.
    switching.markUnavailable(payload.model, {
      reason: `upstream ${last.status}`,
      ms: switching.UPSTREAM_ERROR_COOLDOWN_MS,
    });
  }
  const error = new OpenRouterError(
    `OpenRouter ${label} (${payload.model}${background ? ', background' : ''}): ${last.message}`,
  );
  error.status = last.status;
  error.model = payload.model;
  throw error;
}

/**
 * @param {Array} messages
 * @param {object} [opts]
 * @param {string} [opts.model]
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.temperature]
 * @param {AbortSignal} [opts.signal]
 * @param {Array} [opts.tools] OpenAI-style function-calling schemas
 * @param {(name: string, args: object) => Promise<string>} [opts.toolHandler]
 * @param {number} [opts.maxToolRounds] rounds of tool calls before the model
 *   is forced to answer without tools (default 4)
 * @param {(toolCalls: Array) => Promise<void>} [opts.onToolCalls] awaited
 *   once, right before the FIRST round of tool calls actually runs — lets a
 *   caller surface "on it, doing X" feedback for a slow multi-step action
 *   (voice.js uses this to speak a heads-up before an owner tool call
 *   executes, same as the Python bot's on_tool_calls)
 * @param {boolean} [opts.background] mark this as background work: it counts
 *   against the hourly spend cap, and defaults to the cheap utility model
 *   instead of the conversational one
 * @param {string} [opts.guildId] which server this call is for, so it can be
 *   billed to that server's account. Omitted means unbilled — which is what
 *   every self-hosted install gets, and what the tests get.
 * @returns {Promise<string>} the assistant's final reply text
 * @throws {InsufficientCreditsError} before making any provider call, when
 *   the guild's account has run dry
 */
export async function chat(messages, {
  model, maxTokens = 1000, temperature = 0.7, signal,
  tools, toolHandler, maxToolRounds = 4, onToolCalls, background = false,
  guildId = null,
} = {}) {
  if (!OPENROUTER_API_KEY) throw new OpenRouterError('OPENROUTER_API_KEY is not set');
  // Credit first, then the hourly breaker. Both refuse to start work; this
  // one is the customer-visible reason, and it should win the race to explain
  // itself rather than being masked by an internal budget message.
  const billing = credits.gate(guildId);
  if (background) bgBudgetCheck();
  const conversation = [...messages];
  let useTools = Boolean(tools?.length && toolHandler);
  let junkRetries = 0;

  // Billing is per reply, not per HTTP request: a tool loop or a junk re-roll
  // can take several round trips to produce the one answer the customer
  // actually receives, and the rate card sells "per reply". The real token
  // counts ride along on the usage event so margin can be checked against the
  // provider invoice later, which is what would catch that assumption going
  // bad for a particularly expensive tool loop.
  const modelId = model || (background ? OPENROUTER_UTILITY_MODEL : OPENROUTER_MODEL);
  const spend = {
    rounds: 0, promptTokens: 0, completionTokens: 0, providerRef: null,
  };
  const meterReply = () => credits.meter(billing, {
    kind: credits.chatKind({ model: modelId, background }),
    quantity: 1,
    providerRef: spend.providerRef,
    meta: {
      model: modelId,
      rounds: spend.rounds,
      prompt_tokens: spend.promptTokens,
      completion_tokens: spend.completionTokens,
    },
  });

  // The extra JUNK_RETRIES iterations are re-rolls, not tool rounds — a
  // junk verdict must not eat the model's budget for actually using tools.
  for (let round = 0; round <= maxToolRounds + JUNK_RETRIES; round += 1) {
    const payload = {
      model: modelId,
      messages: conversation,
      max_tokens: maxTokens,
      temperature,
    };
    if (useTools && round < maxToolRounds) payload.tools = tools;

    let data;
    try {
      // eslint-disable-next-line no-await-in-loop
      data = await requestCompletion(payload, signal, background);
    } catch (err) {
      // Free-pool (and some budget) models don't support tool calling —
      // degrade to a plain reply instead of failing outright.
      if (err instanceof ToolUnsupportedError) {
        console.warn(`[openrouter] model rejected tool use — retrying without tools (${err.message.slice(0, 120)})`);
        useTools = false;
        round -= 1; // retry this same round without tools
        continue;
      }
      // Likewise for image input — losing the picture beats losing the reply.
      if (err instanceof ImageUnsupportedError) {
        const stripped = stripImageParts(conversation);
        if (!stripped.changed) {
          // Nothing to strip, so a retry would send the identical payload and
          // fail identically. Surface it instead of spinning the round budget.
          throw new OpenRouterError(
            `OpenRouter rejected image input (${payload.model}): ${err.message}`,
          );
        }
        console.warn(`[openrouter] model rejected image input — retrying without images (${err.message.slice(0, 120)})`);
        // In place: `conversation` is the array later rounds keep pushing tool
        // results onto, so it has to stay the same binding, not be rebound.
        conversation.splice(0, conversation.length, ...stripped.messages);
        round -= 1; // retry this same round text-only
        continue;
      }
      // Background work reroutes itself. Nobody is listening at 3am when
      // memory consolidation fails, so there is no one to offer a choice to —
      // and the alternative is that consolidation simply stops for the rest
      // of the day, which is how a free-model daily quota quietly turns into
      // a bot that has forgotten everything since lunchtime.
      //
      // This call still fails: background gets exactly one shot by design, and
      // retrying it here would have it compete with the conversation for the
      // same rate limit. The NEXT background call picks up the new model.
      //
      // 5xx gets the same treatment as 429, and for a worse reason: parking
      // the model is not enough on its own, because the background role reads
      // its model from a stored setting rather than from the shortlist. A
      // model that can never answer us — a music or image generator that
      // rotation picked up before the catalog knew to exclude it — would
      // otherwise return 502 on every background call for the life of the
      // install. Rotating rewrites the setting, so the next call goes
      // somewhere else.
      if (background && guildId && (err.status === 429 || err.status >= 500)) {
        switching.rotateBackground(guildId);
      }
      throw err;
    }
    const reply = data?.choices?.[0]?.message;
    if (!reply) {
      throw new OpenRouterError(`Unexpected OpenRouter response: ${JSON.stringify(data).slice(0, 300)}`);
    }

    const usage = data.usage || {};
    console.log(`[llm] ${payload.model}${background ? ' [bg]' : ''} `
      + `in=${usage.prompt_tokens ?? '?'} out=${usage.completion_tokens ?? '?'}`);
    spend.rounds += 1;
    spend.promptTokens += usage.prompt_tokens || 0;
    spend.completionTokens += usage.completion_tokens || 0;
    if (data?.id) spend.providerRef = data.id;

    const toolCalls = reply.tool_calls;
    if (!(toolCalls?.length && useTools)) {
      const content = reply.content || '';
      if (junkRetries < JUNK_RETRIES && (isJunkVerdict(content) || hasDegenerateRepetition(content))) {
        junkRetries += 1;
        const cause = isJunkVerdict(content) ? 'junk safety verdict' : 'degenerate repetition';
        console.log(`[openrouter] ${cause} from ${payload.model} — re-rolling (${junkRetries}/${JUNK_RETRIES})`);
        continue;
      }
      // Metered here, at the one point a reply is actually produced — never
      // on the throw paths. A call that failed outright cost the customer
      // nothing, whatever it cost us.
      meterReply();
      return content;
    }

    conversation.push(reply);
    if (onToolCalls) {
      await onToolCalls(toolCalls);
      onToolCalls = undefined; // only announce once, on the first round
    }
    for (const call of toolCalls) {
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || '{}');
      } catch { /* leave args empty on malformed JSON from the model */ }
      // eslint-disable-next-line no-await-in-loop
      const result = await toolHandler(call.function.name, args);
      conversation.push({ role: 'tool', tool_call_id: call.id || '', content: result });
    }
  }
  throw new OpenRouterError('Tool loop ended without a final answer');
}
