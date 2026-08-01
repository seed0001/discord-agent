// Live persistent memory, per guild — plus per-member profile cards so one
// person's context doesn't get lost inside the general guild-wide dump.
// Ported from memory.py.
//
// Every turn (text or voice, any speaker) triggers a background
// consolidation that rewrites durable memory (stable guild-wide facts),
// working memory (live conversation context), and per-member profile cards
// in one shot — from only the turns that are new since the last successful
// run (a per-guild watermark, so already-folded-in turns aren't reprocessed
// on every single turn).
//
// Durability: the raw-turn buffer here is in-process, so a bare design
// would lose anything said since the last consolidation if the process died
// — a Railway redeploy landing mid-conversation, say. Every turn is written
// to db.turns the moment it's recorded, and restorePendingTurns() replays
// whatever never made it through a successful consolidation at startup.
// Unlike the Python original, db.js is synchronous, so that write has
// already landed by the time recordTurn() returns — there is no window at
// all between "recorded" and "persisted".
//
// db.turns is never deleted once consolidated — it's the permanent chat/
// voice log. recall() (the recall_chat_log tool) searches it directly, so
// if a consolidation pass ever compresses or misses something, the actual
// words said are still there. The summarized memory is a fast-path index
// into that log, not the only copy.
//
// Every turn from the owner is additionally appended verbatim to their
// manuscript — no toggle, no command, unconditional.
import { OWNER_ID } from './config.js';
import { chat, OpenRouterError } from './openrouter.js';
import * as db from './db.js';

const TURN_BUFFER = 60;        // raw turns kept per guild for consolidation
const TURN_MAX_CHARS = 300;    // per-turn cap fed to the updater
const WORKING_MAX = 2500;      // char caps requested from the model
const DURABLE_MAX = 5000;
const PROFILE_FIELD_MAX = 800; // per-field cap on a profile card

// Preservation spot-check: a member's raw turns this round must overlap this
// much (by significant-word set) with what the model kept about them, once
// their raw content is substantial enough to be worth checking at all.
const DROP_CHECK_MIN_CHARS = 150;
const DROP_PRESERVATION_MIN = 0.12;
const PENDING_MAX = 2000;      // raw text carried forward for a retry, capped

const STOPWORDS = new Set([
  'about', 'after', 'again', 'their', 'there', 'these', 'those', 'which',
  'would', 'could', 'should', 'because', 'before', 'still', 'where',
  'while', 'being', 'doing', 'going', 'think', 'thought', 'really',
  'actually', 'someone', 'something', 'anything', 'everything', 'people',
]);

const turns = new Map();               // guildId -> array of turn objects
const consolidating = new Map();       // guildId -> a consolidation is in flight
const pending = new Map();             // guildId -> turns arrived while it ran
const nextSeq = new Map();             // guildId -> per-guild turn counter
const lastConsolidatedSeq = new Map(); // guildId -> watermark already folded in

const get = (map, key, fallback) => (map.has(key) ? map.get(key) : fallback);

const CONSOLIDATE_PROMPT = ({ today, durable, working, profilesBlock, turnsBlock }) => (
  'You maintain the memory of a Discord server bot: durable guild-wide '
  + 'memory, working memory, and per-member profile cards.\n\n'
  + 'SYSTEM INSTRUCTION: before writing anything, tag every fact you find '
  + 'with the member it came from or is about, using their display name '
  + 'exactly as it appears in the turns below. A fact about one specific '
  + 'member belongs on that member\'s profile card, not folded into general '
  + 'durable memory. Only genuinely guild-wide facts — not about one '
  + 'person — go in durable memory. Do not drop a member\'s facts just '
  + 'because their turns are dense or another member talked more this '
  + 'round: every member with substantive new information below must get '
  + 'a profile update.\n\n'
  + 'Capture SPECIFICS, not summaries: names, numbers, dates, tool/tech '
  + 'names, exact preferences, personal history, anything concrete. '
  + '\'they mentioned a project\' is useless; \'building a Discord bot called '
  + 'Max on Railway, using OpenRouter\' is what you\'re for. When a fact '
  + 'doesn\'t fit goals/active_projects/constraints/vibe_notes, it still '
  + 'belongs somewhere — put it in notes rather than leaving it out. '
  + 'Never compress a member\'s turns into a vaguer restatement just to '
  + 'save space; drop something only when it\'s truly superseded by '
  + 'newer information about the same thing.\n\n'
  + `DURABLE MEMORY (guild-wide facts, dated, confidence-tagged) — today is ${today}:\n${durable}\n\n`
  + `WORKING MEMORY (live conversation context):\n${working}\n\n`
  + 'CURRENT MEMBER PROFILES (update these — merge in new information, '
  + `keep existing fields the new turns don't mention):\n${profilesBlock}\n\n`
  + 'RECENT TURNS — each is tagged with where it happened, e.g. "[#general]" '
  + 'for a text channel or "[voice/General]" for a voice channel — keep that '
  + 'location when it\'s relevant to a fact or open question, so the bot can '
  + 'later answer things like "did you see what I posted in #general":\n'
  + `${turnsBlock}\n\n`
  + 'Roll working memory into durable memory: merge, dedupe, drop '
  + `superseded entries (durable under ${DURABLE_MAX} chars). Trim working `
  + `memory to only still-live context (under ${WORKING_MAX} chars). `
  + 'Profile card fields: goals, active_projects, constraints, vibe_notes, '
  + 'notes (catch-all for concrete facts about them that don\'t fit the '
  + 'other fields — the more specific the better) — each a string, and '
  + 'each can run long if there\'s genuinely that much detail to keep.\n'
  + 'Reply with ONLY a JSON object: {"durable": "...", "working": "...", '
  + '"profiles": {"<member display name>": {"goals": "...", '
  + '"active_projects": "...", "constraints": "...", "vibe_notes": "...", '
  + '"notes": "..."}}}\n'
  + 'Only include members in "profiles" who had genuinely new or updated '
  + 'information this round.'
);

const today = () => new Date().toISOString().slice(0, 10);

function isOwnerId(userId) {
  return Boolean(OWNER_ID) && String(userId) === String(OWNER_ID);
}

/** Fire-and-forget background work; a failure must never break a message. */
function schedule(factory) {
  Promise.resolve().then(factory).catch((err) => {
    console.error('[memory] maintenance failed:', err?.message || err);
  });
}

/**
 * Buffer a conversation turn and trigger a live memory consolidation.
 *
 * userId identifies the human who said this (for profile-card tagging at
 * consolidation time) — leave it null for the bot's own turns, since Max
 * doesn't get a profile card built about himself. channel is the text or
 * voice channel name, so memory can tell where something was said, which is
 * the whole point of "did you see what I posted in #general".
 */
export function recordTurn(guildId, speaker, text, { source = 'text', userId = null, channel = '' } = {}) {
  const body = (text || '').trim();
  if (!body) return;
  const gid = String(guildId);

  // Sequence numbers start at 1 so the "nothing consolidated yet" watermark
  // of 0 doesn't exclude the very first turn (0 > 0 is false).
  const seq = get(nextSeq, gid, 0) + 1;
  nextSeq.set(gid, seq);

  const ts = Date.now() / 1000;
  const turn = {
    speaker, user_id: userId, text: body.slice(0, TURN_MAX_CHARS),
    source, channel, ts, seq,
  };
  if (!turns.has(gid)) turns.set(gid, []);
  const buf = turns.get(gid);
  buf.push(turn);
  while (buf.length > TURN_BUFFER) buf.shift();

  // Durability backstop, written before consolidation ever runs. The full
  // untruncated text is what's persisted — TURN_MAX_CHARS only caps what
  // consolidation reads.
  db.addTurn(gid, seq, speaker, userId, body, source, channel, ts);
  // Manuscript: verbatim capture of everything the owner says. Not opt-in,
  // by design — it must never depend on remembering to switch it on first.
  if (userId !== null && isOwnerId(userId)) db.appendManuscript(gid, userId, body);

  triggerConsolidation(gid);
}

/**
 * Reload turns that were persisted but never made it through a successful
 * consolidation before the last shutdown. Call once at startup, after
 * initDb(); each recovered guild's backlog is folded in immediately.
 */
export function restorePendingTurns() {
  for (const guildId of db.getPendingTurnGuilds()) {
    const rows = db.getPendingTurns(guildId);
    if (!rows.length) continue;
    const gid = String(guildId);
    if (!turns.has(gid)) turns.set(gid, []);
    const buf = turns.get(gid);
    for (const row of rows) buf.push(row);
    while (buf.length > TURN_BUFFER) buf.shift();
    nextSeq.set(gid, Math.max(get(nextSeq, gid, 0), rows[rows.length - 1].seq));
    console.log(`[memory] recovered ${rows.length} unconsolidated turn(s) for guild ${gid} after restart`);
    triggerConsolidation(gid);
  }
}

/**
 * Consolidation runs for every turn, but coalesces rather than piling up
 * overlapping calls: if one is already in flight for this guild, flag that
 * fresher turns arrived and let the running pass loop once more after it.
 */
function triggerConsolidation(guildId) {
  if (!consolidationEnabled) return;
  if (get(consolidating, guildId, false)) {
    pending.set(guildId, true);
    return;
  }
  consolidating.set(guildId, true);
  schedule(async () => {
    try {
      for (;;) {
        pending.set(guildId, false);
        // eslint-disable-next-line no-await-in-loop
        await consolidate(guildId);
        if (!get(pending, guildId, false)) return;
      }
    } finally {
      consolidating.set(guildId, false);
    }
  });
}

function location(t) {
  if (!t.channel) return t.source;
  return t.source === 'text' ? `#${t.channel}` : `voice/${t.channel}`;
}

function formatTurns(list) {
  return list.map((t) => `[${location(t)}] ${t.speaker}: ${t.text}`).join('\n');
}

function formatLogTurns(list) {
  return list.map((t) => {
    const date = t.ts
      ? new Date(t.ts * 1000).toISOString().slice(0, 16).replace('T', ' ')
      : '?';
    return `[${date} ${location(t)}] ${t.speaker}: ${t.text}`;
  }).join('\n');
}

export const RECALL_TOOL_SCHEMA = {
  type: 'function',
  function: {
    name: 'recall_chat_log',
    description: 'Search the permanent raw chat/voice log for this server — every '
      + 'turn ever recorded, not just what made it into durable memory or a '
      + 'profile card summary. Use this when someone asks what they told you '
      + 'before, references something you don\'t have summarized, or you want '
      + 'to double-check exactly what was said and when, instead of relying '
      + 'on a compressed summary.',
    parameters: {
      type: 'object',
      properties: {
        member: { type: 'string', description: 'Filter to one member\'s display name (optional)' },
        query: { type: 'string', description: 'Keyword/phrase to search for in the text (optional)' },
        limit: { type: 'integer', description: 'Max turns to return, most recent first (default 40, max 100)' },
      },
      required: [],
    },
  },
};

/**
 * Search the permanent raw chat log directly — the actual words said, not
 * the AI-summarized durable memory or profile cards — so a bad
 * consolidation pass never means the information is genuinely gone.
 */
export function recall(guildId, { member, query, limit = 40 } = {}) {
  const capped = Math.max(1, Math.min(parseInt(limit, 10) || 40, 100));
  const rows = db.getChatLog(guildId, {
    speakerQuery: member || undefined,
    textQuery: query || undefined,
    limit: capped,
  });
  if (!rows.length) return 'No matching chat history found.';
  return formatLogTurns([...rows].reverse());
}

/**
 * Memory block for injection into the system prompt ('' if empty).
 *
 * When userId is given and that member has a profile card, it's loaded
 * FIRST — ahead of the general guild-wide dump — so a specific person's
 * context isn't glossed over in a sea of unrelated facts.
 */
export function getContext(guildId, userId = null) {
  const parts = [];
  if (userId !== null) {
    const profileBlock = formatProfile(guildId, userId);
    if (profileBlock) parts.push(profileBlock);
  }
  const durable = db.getMemory(guildId, 'durable')?.content || '';
  const working = db.getMemory(guildId, 'working')?.content || '';
  if (durable) parts.push(`[DURABLE MEMORY — long-term facts you know]\n${durable}`);
  if (working) parts.push(`[WORKING MEMORY — the current conversation context]\n${working}`);
  return parts.join('\n\n');
}

function formatProfile(guildId, userId) {
  const card = loadProfile(guildId, userId);
  if (!card) return '';
  const lines = [`Name: ${card.name || '?'}`];
  const fields = [['Goals', 'goals'], ['Active projects', 'active_projects'],
    ['Constraints', 'constraints'], ['Vibe notes', 'vibe_notes'], ['Notes', 'notes']];
  for (const [label, key] of fields) {
    if (card[key]) lines.push(`${label}: ${card[key]}`);
  }
  if (card.last_conversation) lines.push(`Last conversation: ${card.last_conversation}`);
  return `[SPEAKER PROFILE — who you're talking to right now]\n${lines.join('\n')}`;
}

function loadProfile(guildId, userId) {
  const raw = db.getMemory(guildId, `profile:${userId}`)?.content;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function consolidate(guildId) {
  // Only what's new since the last successful consolidation — not the whole
  // rolling buffer. Running every turn already keeps memory live;
  // reprocessing up to 60 already-folded-in turns on top of that every time
  // was pure waste (bigger prompts, more truncation risk) for no benefit.
  const watermark = get(lastConsolidatedSeq, guildId, 0);
  const newTurns = (turns.get(guildId) || []).filter((t) => t.seq > watermark);
  if (!newTurns.length) return;

  const durable = db.getMemory(guildId, 'durable')?.content || '';
  const working = db.getMemory(guildId, 'working')?.content || '';

  // Group this round's turns by member (the bot's own turns carry no
  // user_id and are excluded — Max doesn't get profiled).
  const byMember = new Map();
  const names = new Map();
  for (const t of newTurns) {
    if (t.user_id === null || t.user_id === undefined) continue;
    const uid = String(t.user_id);
    if (!byMember.has(uid)) byMember.set(uid, []);
    byMember.get(uid).push(t);
    names.set(uid, t.speaker); // latest display name wins
  }

  const pendingByMember = new Map();
  const profileLines = [];
  for (const [uid, name] of names) {
    const existing = loadProfile(guildId, uid);
    const carried = db.getMemory(guildId, `pending:${uid}`)?.content || '';
    if (carried) pendingByMember.set(uid, carried);
    let line = `${name}: ${existing ? JSON.stringify(existing) : '(no card yet)'}`;
    if (carried) {
      line += `\n  [NOTE: facts about ${name} were dropped in a prior pass — `
        + `make sure these are captured this time: ${carried}]`;
    }
    profileLines.push(line);
  }
  const profilesBlock = profileLines.join('\n') || '(no members with new activity this round)';

  const prompt = CONSOLIDATE_PROMPT({
    today: today(),
    durable: durable || '(empty)',
    working: working || '(empty)',
    profilesBlock,
    turnsBlock: formatTurns(newTurns) || '(none)',
  });

  let reply;
  try {
    // Enough headroom to reproduce durable_max + working_max chars plus
    // profile JSON without being cut off mid-object — a tighter budget
    // produced truncated, unparseable JSON and silently dropped updates.
    reply = await chat([{ role: 'user', content: prompt }], {
      model: db.getSetting(guildId, 'ai_utility_model') || undefined,
      temperature: 0.2,
      maxTokens: 4096,
      background: true,
    });
  } catch (err) {
    if (err instanceof OpenRouterError) {
      console.warn('[memory] consolidation failed:', err.message);
      return;
    }
    throw err;
  }

  const parsed = parseConsolidation(reply);
  if (!parsed) {
    console.warn('[memory] consolidation reply unparseable; keeping memory as-is');
    return;
  }
  const { durable: newDurable, working: newWorking, profiles } = parsed;
  const highSeq = newTurns[newTurns.length - 1].seq;
  lastConsolidatedSeq.set(guildId, highSeq);
  // Safely folded in — mark consolidated so they aren't replayed at the next
  // startup. The rows stay in the table forever as the searchable chat log.
  db.markTurnsConsolidated(guildId, highSeq);

  db.setMemory(guildId, 'durable', newDurable.slice(0, DURABLE_MAX + 1000));
  db.setMemory(guildId, 'working', newWorking.slice(0, WORKING_MAX + 500));

  const updatedByName = new Map();
  for (const [key, value] of Object.entries(profiles)) {
    if (value && typeof value === 'object') updatedByName.set(String(key).trim().toLowerCase(), value);
  }

  for (const [uid, memberTurns] of byMember) {
    const name = names.get(uid);
    let rawText = memberTurns.map((t) => t.text).join('\n');
    if (pendingByMember.has(uid)) rawText = `${pendingByMember.get(uid)}\n${rawText}`;
    const newFields = updatedByName.get(name.trim().toLowerCase());

    const substantial = rawText.length >= DROP_CHECK_MIN_CHARS;
    const ratio = preservationRatio(rawText, newFields ? JSON.stringify(newFields) : '');
    if (substantial && ratio < DROP_PRESERVATION_MIN) {
      console.warn(`[memory] consolidation may have dropped ${name}'s facts `
        + `(preservation ${Math.round(ratio * 100)}%, ${rawText.length} raw chars) — `
        + 'flagging and retaining raw turns for the next pass');
      db.setMemory(guildId, `pending:${uid}`, rawText.slice(-PENDING_MAX));
    } else if (pendingByMember.has(uid)) {
      db.setMemory(guildId, `pending:${uid}`, ''); // captured now
    }

    if (newFields) saveProfile(guildId, uid, name, newFields);
  }

  console.log(`[memory] consolidated for guild ${guildId} (${byMember.size} member(s) active this round)`);
}

/** Merge new profile fields in — never blind-overwrite fields the model
 * didn't mention this round. */
function saveProfile(guildId, userId, name, fields) {
  const existing = loadProfile(guildId, userId) || {};
  existing.name = name;
  existing.user_id = userId;
  existing.last_conversation = today();
  for (const key of ['goals', 'active_projects', 'constraints', 'vibe_notes', 'notes']) {
    const value = fields[key];
    if (value) existing[key] = String(value).slice(0, PROFILE_FIELD_MAX);
  }
  db.setMemory(guildId, `profile:${userId}`, JSON.stringify(existing));
}

const ACRONYM_RE = /\b[A-Z]{2,6}\b|\b[A-Za-z]+\d+\b|\b\d+[A-Za-z]+\b/g;

export function significantTokens(text) {
  const words = new Set(
    (text.toLowerCase().match(/[a-z]{5,}/g) || []).filter((w) => !STOPWORDS.has(w)),
  );
  // A pure length filter throws away short technical terms that carry most
  // of the meaning in a constraint/project fact (TLS, ARM, arm64, 256mb) —
  // catch acronyms and alphanumeric tokens from the original-case text too.
  for (const w of text.match(ACRONYM_RE) || []) words.add(w.toLowerCase());
  return words;
}

/** Fraction of rawText's significant vocabulary that survived into
 * outputText — a cheap, deterministic stand-in for "did the model actually
 * keep this", with no extra model call. */
export function preservationRatio(rawText, outputText) {
  const rawTokens = significantTokens(rawText);
  if (!rawTokens.size) return 1.0; // nothing substantive to lose
  const outTokens = significantTokens(outputText);
  let kept = 0;
  for (const token of rawTokens) if (outTokens.has(token)) kept += 1;
  return kept / rawTokens.size;
}

/** Extract {durable, working, profiles} from the model reply, tolerating
 * code fences. Returns null when the reply can't be parsed at all. */
export function parseConsolidation(reply) {
  let text = (reply || '').trim();
  if (text.startsWith('```')) {
    const parts = text.split('```');
    text = parts[1] || '';
    const newline = text.indexOf('\n');
    if (newline !== -1) text = text.slice(newline + 1);
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  let data;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const profiles = data.profiles && typeof data.profiles === 'object' ? data.profiles : {};
  return {
    durable: String(data.durable ?? '').trim(),
    working: String(data.working ?? '').trim(),
    profiles,
  };
}

// Test seam. Consolidation is fire-and-forget and makes a model call, so
// tests that exercise the recording/recall path switch it off rather than
// reaching the network or racing a closed database on teardown.
let consolidationEnabled = true;

export function _setConsolidationEnabled(value) {
  consolidationEnabled = value;
}

/** Test seam: drop all in-process buffers/watermarks. */
export function _resetForTests() {
  turns.clear();
  consolidating.clear();
  pending.clear();
  nextSeq.clear();
  lastConsolidatedSeq.clear();
}
