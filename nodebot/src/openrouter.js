// OpenRouter chat-completions client, with tool-calling — ported from
// openrouter.py's agent loop, including the background spend-cap breaker
// and the free-pool junk-verdict re-roll.
import {
  OPENROUTER_API_KEY, OPENROUTER_MODEL,
  OPENROUTER_UTILITY_MODEL, OPENROUTER_BG_HOURLY_CAP,
} from './config.js';

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

// One model in the free pool answers everything with a bare safety verdict
// ("user safety safe"). Detect that and re-roll so the free router picks a
// different model, rather than passing the junk through as Max's reply.
const JUNK_VERDICT_RE = /^\W*(user\s*safety\W*)?(safe|unsafe)\W*$/i;
const JUNK_RETRIES = 2;

function isJunkVerdict(content) {
  const text = (content || '').trim();
  return text.length < 40 && JUNK_VERDICT_RE.test(text);
}

const RETRYABLE_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;              // additional attempts, foreground only
const BASE_BACKOFF_MS = 700;
const MAX_BACKOFF_MS = 8_000;

/** Signals "this model can't do tool calling" so the caller can re-run the
 * same round without tools. Internal — never escapes chat(). */
class ToolUnsupportedError extends Error {}

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

    last = err;
    if (!RETRYABLE_STATUSES.has(err.status) || attempt === attempts) break;
    const wait = backoffMs(attempt, resp.headers?.get?.('retry-after'));
    console.warn(`[openrouter] ${err.status} from ${payload.model} — `
      + `retrying in ${wait}ms (attempt ${attempt}/${attempts - 1})`);
    // eslint-disable-next-line no-await-in-loop
    await sleep(wait, signal);
  }
  const label = last.status === 429 ? 'rate limited' : `error ${last.status}`;
  throw new OpenRouterError(
    `OpenRouter ${label} (${payload.model}${background ? ', background' : ''}): ${last.message}`,
  );
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
 * @returns {Promise<string>} the assistant's final reply text
 */
export async function chat(messages, {
  model, maxTokens = 1000, temperature = 0.7, signal,
  tools, toolHandler, maxToolRounds = 4, onToolCalls, background = false,
} = {}) {
  if (!OPENROUTER_API_KEY) throw new OpenRouterError('OPENROUTER_API_KEY is not set');
  if (background) bgBudgetCheck();
  const conversation = [...messages];
  let useTools = Boolean(tools?.length && toolHandler);
  let junkRetries = 0;

  // The extra JUNK_RETRIES iterations are re-rolls, not tool rounds — a
  // junk verdict must not eat the model's budget for actually using tools.
  for (let round = 0; round <= maxToolRounds + JUNK_RETRIES; round += 1) {
    const payload = {
      model: model || (background ? OPENROUTER_UTILITY_MODEL : OPENROUTER_MODEL),
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
      throw err;
    }
    const reply = data?.choices?.[0]?.message;
    if (!reply) {
      throw new OpenRouterError(`Unexpected OpenRouter response: ${JSON.stringify(data).slice(0, 300)}`);
    }

    const usage = data.usage || {};
    console.log(`[llm] ${payload.model}${background ? ' [bg]' : ''} `
      + `in=${usage.prompt_tokens ?? '?'} out=${usage.completion_tokens ?? '?'}`);

    const toolCalls = reply.tool_calls;
    if (!(toolCalls?.length && useTools)) {
      const content = reply.content || '';
      if (isJunkVerdict(content) && junkRetries < JUNK_RETRIES) {
        junkRetries += 1;
        console.log(`[openrouter] junk safety verdict from ${payload.model} — re-rolling (${junkRetries}/${JUNK_RETRIES})`);
        continue;
      }
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
