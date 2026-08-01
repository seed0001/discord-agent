// Proactive speech — wires the pressure engine into Max. Ported from
// bot/cogs/proactive.py.
//
// Every guild message (and voice transcript, fed by voice.js) is observed and
// classified into pressure signals by a cheap LLM call. A background tick
// decays/flows pressure. When a (bucket, topic) crosses its threshold and the
// deterministic speaking gate would allow it, Max drafts a contribution in his
// own voice; the gate rules on the final draft, and only then does he speak
// unprompted. Every limit — thresholds, cooldowns, repetition, budgets,
// energy — is enforced by the engine, not the model.
import path from 'node:path';
import { ChannelType } from 'discord.js';
import { DATABASE_PATH } from './config.js';
import { chat, OpenRouterError } from './openrouter.js';
import { PressureEngine, SqliteStore, makeSignal, makeProposal, strength } from './pressure/index.js';
import * as deescalate from './deescalate.js';
import * as memory from './memory.js';
import * as tts from './tts.js';
import * as db from './db.js';

const TICK_EVERY_MS = 30_000;      // between engine ticks
const CLASSIFY_MIN_INTERVAL = 20.0; // per-channel rate cap; messages in between batch
const CLASSIFY_MIN_CHARS = 12;      // skip trivial messages
const CONTEXT_LINES = 12;           // recent lines given to classifier/drafter
const VOICE_CONFIDENCE_SCALE = 0.85; // transcripts are noisier than typed text

const CLASSIFY_PROMPT = ({ sources, context, text }) => (
  'You monitor a Discord channel for an assistant bot that may speak up '
  + 'unprompted when it truly has something to offer. Given the recent '
  + 'messages and the newest one, emit conversational pressure signals.\n'
  + `Allowed sources: ${sources}\n`
  + 'Reply ONLY with JSON: {"topic": "short-kebab-slug", "signals": '
  + '[{"source": "...", "confidence": 0.0-1.0, "evidence": "one short line"}]}\n'
  + 'topic = what the conversation is about right now (always set it). '
  + 'For ordinary chatter return an empty signals list. NEVER invent '
  + 'signals — fabricated certainty is worse than silence. Use '
  + 'incorrect_claim only for clearly wrong technical claims.\n\n'
  + `Recent messages:\n${context}\n\nNewest messages:\n${text}`
);

const DRAFT_PROMPT = ({ channel, topic, bucket, evidence, context }) => (
  `\nPressure has built for you to speak UNPROMPTED in the channel "${channel}" `
  + `about "${topic}" (drive: ${bucket}). The signals:\n${evidence}\n\n`
  + `Recent conversation:\n${context}\n\n`
  + 'Decide honestly whether you have something NEW and genuinely useful to '
  + 'add. If not, decline — silence is fine. If yes, write the message in '
  + 'your usual voice: short, conversational, no markdown walls, at most 2 '
  + 'questions.\n'
  + 'Reply ONLY with JSON: {"speak": true/false, "message": "...", '
  + '"content_key": "slug-identifying-the-point", "relevance": 0.0-1.0}'
);

const engines = new Map();      // guildId -> PressureEngine
const context = new Map();      // channelId -> recent lines
const pendingLines = new Map(); // channelId -> lines awaiting classification
const lastClassify = new Map(); // channelId -> timestamp
let ticker = null;

/** Tolerant JSON extraction (handles code fences and prose padding). */
export function parseJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function engineFor(guildId) {
  const key = String(guildId);
  if (!engines.has(key)) {
    // Its own database file per guild, beside the bot's — the engine's state
    // is deliberately isolated from the bot's tables.
    const base = path.dirname(DATABASE_PATH) || '.';
    engines.set(key, new PressureEngine(new SqliteStore(path.join(base, `pressure-${key}.db`))));
  }
  return engines.get(key);
}

function pushContext(channelId, line) {
  const key = String(channelId);
  if (!context.has(key)) context.set(key, []);
  const lines = context.get(key);
  lines.push(line);
  while (lines.length > CONTEXT_LINES) lines.shift();
}

// -- observation & classification ---------------------------------------------

export async function handleMessage(client, message) {
  if (!message.guild) return;
  const now = Date.now() / 1000;
  const engine = engineFor(message.guild.id);
  if (message.author.bot) {
    if (message.author.id === client.user.id) {
      // Max's own messages are observed but never generate pressure.
      engine.observeMessage(now, String(message.channel.id), String(message.author.id), true);
    }
    return;
  }
  const text = message.content.trim();
  pushContext(message.channel.id, `${message.author.displayName || message.author.username}: ${text.slice(0, 200)}`);
  engine.observeMessage(now, String(message.channel.id), String(message.author.id), false);
  await classifyAndIngest(
    message.guild, message.channel.id, String(message.author.id),
    message.author.displayName || message.author.username, text, now,
  );
  // Ongoing traffic in a channel with an open conflict gets reassessed.
  await deescalate.observe(message.guild, message.channel.id);
}

/** Called by voice.js for each transcribed utterance. */
export async function feedVoice(guild, channelId, userId, name, text) {
  const now = Date.now() / 1000;
  const engine = engineFor(guild.id);
  pushContext(channelId, `${name} (voice): ${text.slice(0, 200)}`);
  engine.observeMessage(now, String(channelId), String(userId), false);
  await classifyAndIngest(guild, channelId, String(userId), name, text, now, VOICE_CONFIDENCE_SCALE);
}

async function classifyAndIngest(guild, channelId, userId, author, text, now, confidenceScale = 1.0) {
  const guildId = guild.id;
  if (!db.getSetting(guildId, 'pressure_enabled')) return;
  if (db.getSetting(guildId, 'quiet_mode')) return;

  const key = String(channelId);
  if (!pendingLines.has(key)) pendingLines.set(key, []);
  const pending = pendingLines.get(key);
  if (text.length >= CLASSIFY_MIN_CHARS) {
    pending.push(`${author}: ${text.slice(0, 300)}`);
    while (pending.length > 10) pending.shift();
  }
  if (!pending.length) return;
  // The rate cap doubles as batching: everything since the last call goes
  // into one classification instead of one call per message.
  if (now - (lastClassify.get(key) || 0) < CLASSIFY_MIN_INTERVAL) return;
  lastClassify.set(key, now);
  const batch = pending.join('\n');
  pendingLines.set(key, []);

  const engine = engineFor(guildId);
  const recent = (context.get(key) || []).slice(0, -1);
  const prompt = CLASSIFY_PROMPT({
    sources: Object.keys(engine.config.sourceRouting).join(', '),
    context: recent.join('\n') || '(none)',
    text: batch,
  });

  let reply;
  try {
    reply = await chat([{ role: 'user', content: prompt }], {
      model: db.getSetting(guildId, 'ai_utility_model') || undefined,
      temperature: 0.0,
      maxTokens: 300,
      background: true,
    });
  } catch (err) {
    if (err instanceof OpenRouterError) {
      console.warn('[proactive] signal classification failed:', err.message);
      return;
    }
    throw err;
  }

  const data = parseJson(reply);
  if (!data) return;
  const topic = String(data.topic || '').trim().toLowerCase().slice(0, 60);
  if (topic) engine.observeMessage(now, String(channelId), '', true, topic);

  const sourcesSeen = [];
  for (const item of data.signals || []) {
    const source = String(item.source || '');
    sourcesSeen.push(source);
    const confidence = Number(item.confidence);
    if (!Number.isFinite(confidence)) continue;
    const signal = makeSignal({
      key: `${channelId}:${source}:${topic}`,
      source,
      weight: 0,
      confidence: Math.min(1.0, confidence * confidenceScale),
      ts: now,
      topic,
      channel_id: String(channelId),
      user_id: userId,
      evidence: String(item.evidence || '').slice(0, 200),
    });
    if (engine.ingest(signal, now)) {
      console.log(`[proactive] signal ${source}(${topic}) conf=${signal.confidence.toFixed(2)} — ${signal.evidence}`);
    }
  }

  // Safety signals nominate the de-escalation system; its own
  // context-validated gate decides whether Max actually says anything.
  if (sourcesSeen.includes('safety_concern')) {
    try {
      await deescalate.nominate(guild, channelId);
    } catch (err) {
      console.error('[proactive] de-escalation nomination failed:', err?.message || err);
    }
  }
}

// -- tick & proactive speech ---------------------------------------------------

export function startTicker(client) {
  if (ticker) return;
  ticker = setInterval(() => {
    const now = Date.now() / 1000;
    for (const guild of client.guilds.cache.values()) {
      const engine = engines.get(String(guild.id));
      if (!engine) continue;
      try {
        engine.tick(now);
        if (db.getSetting(guild.id, 'pressure_enabled') && !db.getSetting(guild.id, 'quiet_mode')) {
          maybeSpeak(guild, engine, now).catch(
            (err) => console.error('[proactive] speak failed:', err?.message || err),
          );
        }
      } catch (err) {
        console.error('[proactive] tick failed:', err?.message || err);
      }
    }
  }, TICK_EVERY_MS);
  // Don't hold the process open just for the pressure ticker.
  ticker.unref?.();
}

export function stopTicker() {
  if (ticker) clearInterval(ticker);
  ticker = null;
}

async function maybeSpeak(guild, engine, now) {
  for (const cand of engine.candidates(now)) {
    if (cand.pressure < cand.threshold) break; // sorted — nothing further qualifies
    const channel = guild.channels.cache.get(String(cand.channelId || ''));
    if (!channel) continue;
    // Cheap probe first: is the gate even open, before paying for a draft?
    const probe = makeProposal({
      topic: cand.topic,
      bucket: cand.bucket,
      contentKey: `probe-${Math.floor(now)}`,
      summary: '(probe)',
      relevance: 1.0,
      channelId: cand.channelId,
      userId: cand.userId,
    });
    if (!engine.evaluate(probe, now, false).allowed) continue;
    await draftAndSpeak(guild, engine, channel, cand, now);
    return; // at most one proactive contribution per tick
  }
}

async function draftAndSpeak(guild, engine, channel, cand, now) {
  // Checked before drafting, not before speaking: bailing after generation
  // would still have paid for a line nobody ever hears.
  if (await inLiveConversation(channel)) {
    console.log(`[proactive] holding off in #${channel.name} — already mid-conversation`);
    return;
  }
  const evidence = engine.store.signals('active')
    .filter((s) => s.topic === cand.topic && strength(s, now) > 0)
    .map((s) => `- ${s.source}: ${s.evidence || '(no detail)'}`)
    .join('\n') || '(none)';

  const speakerId = /^\d+$/.test(String(cand.userId || '')) ? cand.userId : null;
  const basePrompt = db.getSetting(guild.id, 'ai_system_prompt');
  const memoryBlock = memory.getContext(guild.id, speakerId);
  const system = [basePrompt, memoryBlock].filter(Boolean).join('\n\n');

  const prompt = DRAFT_PROMPT({
    channel: channel.name,
    topic: cand.topic,
    bucket: cand.bucket,
    evidence,
    context: (context.get(String(channel.id)) || []).join('\n') || '(none)',
  });

  let reply;
  try {
    reply = await chat([
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ], {
      model: db.getSetting(guild.id, 'ai_model'),
      temperature: 0.7,
      maxTokens: 500,
    });
  } catch (err) {
    if (err instanceof OpenRouterError) {
      console.warn('[proactive] draft failed:', err.message);
      return;
    }
    throw err;
  }

  const data = parseJson(reply);
  if (!data || !data.speak || !String(data.message || '').trim()) {
    // The model itself declined — discharge so we don't re-draft every tick.
    engine.resolve(now, 'low_confidence', { topic: cand.topic });
    console.log(`[proactive] draft declined for ${cand.bucket}/${cand.topic}`);
    return;
  }

  const message = String(data.message).trim();
  const display = tts.stripVoiceTags(message) || message;
  const proposal = makeProposal({
    topic: cand.topic,
    bucket: cand.bucket,
    contentKey: String(data.content_key || `${cand.topic}-point`).slice(0, 80),
    summary: display.slice(0, 200),
    providesNewInfo: true,
    questionCount: (message.match(/\?/g) || []).length,
    relevance: Number(data.relevance) || 0,
    channelId: cand.channelId,
    userId: cand.userId,
  });

  const decision = engine.evaluate(proposal, now);
  if (!decision.allowed) {
    console.log(`[proactive] gate held final draft (${cand.bucket}/${cand.topic}): `
      + decision.reasons.join('; '));
    return;
  }

  try {
    for (let i = 0; i < display.length; i += 1990) {
      // eslint-disable-next-line no-await-in-loop
      await channel.send(display.slice(i, i + 1990));
    }
  } catch (err) {
    console.warn('[proactive] send failed:', err.message);
    return;
  }
  engine.recordSpoken(proposal, now);
  memory.recordTurn(guild.id, 'Max', display, {
    source: channel.type === ChannelType.GuildVoice ? 'voice' : 'text',
    userId: null,
    channel: channel.name,
  });
  console.log(`[proactive] PROACTIVE (${cand.bucket}/${cand.topic} in #${channel.name}): `
    + display.slice(0, 120));

  // If this went to a voice channel, say it out loud too — the tagged
  // version to TTS, the clean text to the channel.
  if (channel.type === ChannelType.GuildVoice) {
    try {
      const voice = await import('./voice.js');
      await voice.speakInVoice(guild, message);
    } catch (err) {
      console.error('[proactive] voice playback failed:', err?.message || err);
    }
  }
}

/** Is Max mid-conversation in this voice channel right now?
 *
 * speakInVoice() silently returns false when the player is busy, so an
 * unprompted line landing during a live back-and-forth doesn't interrupt —
 * it just vanishes, having already been generated and paid for. Follow-up
 * mode makes that far more likely, so proactive speech stands down instead:
 * he's already talking to them, which is what pressure wanted. */
async function inLiveConversation(channel) {
  if (channel?.type !== ChannelType.GuildVoice) return false;
  try {
    const voice = await import('./voice.js');
    return voice.isFollowUpOpen(channel.id);
  } catch {
    return false;
  }
}

/** Test seam: drop all in-process state. */
export function _resetForTests() {
  engines.clear();
  context.clear();
  pendingLines.clear();
  lastClassify.clear();
  stopTicker();
}
