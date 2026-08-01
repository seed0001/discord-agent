// De-escalation integration: pressure nominates, validated context decides.
// Ported from bot/cogs/deescalate.py. The deterministic gate itself lives in
// deescalation.js — this is the layer that assesses and acts.
//
// Nomination comes from the proactive classifier's safety_concern signals
// (text and voice both flow through it). On nomination — and periodically
// while a conflict is open — the recent conversation is assessed by the
// model into the structured Assessment, and the gate decides: stay quiet,
// one neutral check-in, suggest a pause/DMs, or notify moderators. Max never
// punishes through this system; timeouts/kicks/bans remain human or explicit
// automod decisions.
//
// Ladder state persists per channel in guild settings (restart-safe). Every
// decision — spoken or silent — is logged with its reasons.
import { ChannelType } from 'discord.js';
import { chat, OpenRouterError } from './openrouter.js';
import { makeAssessment, stateFromDict, decide } from './deescalation.js';
import { formatForPrompt } from './conversation.js';
import { logAction } from './utils.js';
import * as db from './db.js';

const ASSESS_MIN_INTERVAL = 25.0; // seconds between assessments per channel
const TRANSCRIPT_LINES = 15;

const ASSESS_PROMPT = (transcript) => (
  'You are reading the temperature of a Discord conversation for a '
  + 'de-escalation system. Judge CONTEXT, not keywords: profanity, loudness, '
  + 'disagreement, teasing, roleplay, and passionate debate are NOT '
  + 'escalation by themselves. Serious signals are: insults repeatedly '
  + 'aimed at a specific person, credible threats, personal hostility that '
  + 'is escalating, sustained disruptive talking-over, or someone\'s request '
  + 'to stop being ignored. Consider who is addressing whom, how many '
  + 'people are involved, repetition, and whether tension is actually '
  + `increasing.\n\nConversation (most recent last):\n${transcript}\n\n`
  + 'Reply ONLY with JSON: {"tension": "rising|steady|falling", '
  + '"participants": N, "targeted_insults": N, "insult_repeat": bool, '
  + '"credible_threat": bool, "stop_ignored": bool, "cross_talk": bool, '
  + '"banter": bool, "harsh_language": bool, "summary": "one line"}'
);

const CHECK_IN_TEXT = 'yo, quick vibe check — things are getting a little heated in here. '
  + 'we all good?';
const SUGGEST_PAUSE_TEXT = "hey, real talk: this one's getting personal. might be worth taking "
  + 'five, or moving it to DMs. no refs needed, just looking out.';

const lastAssess = new Map();   // channelId -> timestamp
const openChannels = new Set(); // channels with a live conflict; DB is the truth
const running = new Set();      // channels with an assessment in flight

/** Tolerant JSON extraction, then validation into an Assessment. */
export function parseAssessment(reply, now) {
  const text = String(reply || '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  let data;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const tension = String(data.tension ?? 'steady').toLowerCase();
  return makeAssessment({
    ts: now,
    tension: ['rising', 'steady', 'falling'].includes(tension) ? tension : 'steady',
    participants: Math.max(1, parseInt(data.participants, 10) || 2),
    targetedInsults: Math.max(0, parseInt(data.targeted_insults, 10) || 0),
    insultRepeat: Boolean(data.insult_repeat),
    credibleThreat: Boolean(data.credible_threat),
    stopIgnored: Boolean(data.stop_ignored),
    crossTalk: Boolean(data.cross_talk),
    banter: Boolean(data.banter),
    harshLanguage: Boolean(data.harsh_language),
    summary: String(data.summary ?? '').slice(0, 200),
  });
}

function loadState(guildId, channelId) {
  return stateFromDict(db.getSetting(guildId, `deesc:${channelId}`));
}

function saveState(guildId, channelId, state) {
  db.setSetting(guildId, `deesc:${channelId}`, state);
}

/** A safety signal nominated this moment. Context decides the rest. */
export async function nominate(guild, channelId) {
  return run(guild, channelId, 'nomination');
}

/** Ongoing traffic in a channel with an open conflict — reassess. */
export async function observe(guild, channelId) {
  if (openChannels.has(String(channelId))) return run(guild, channelId, 'observation');
  return undefined;
}

async function run(guild, channelId, source) {
  const guildId = guild.id;
  const key = String(channelId);
  if (!db.getSetting(guildId, 'deesc_enabled')) return;
  if (db.getSetting(guildId, 'quiet_mode')) return;
  const now = Date.now() / 1000;
  if (now - (lastAssess.get(key) || 0) < ASSESS_MIN_INTERVAL) return;
  lastAssess.set(key, now);

  // The Python version held an asyncio.Lock per channel. Same intent here:
  // an assessment is a slow model call, and a second one must not interleave
  // and write a stale ladder state over a fresher one.
  if (running.has(key)) return;
  running.add(key);
  try {
    const transcript = formatForPrompt(guildId, TRANSCRIPT_LINES);
    if (!transcript) return;

    let reply;
    try {
      reply = await chat([{ role: 'user', content: ASSESS_PROMPT(transcript) }], {
        model: db.getSetting(guildId, 'ai_utility_model') || undefined,
        temperature: 0.0,
        maxTokens: 250,
        background: true,
      });
    } catch (err) {
      if (err instanceof OpenRouterError) {
        console.warn('[deesc] assessment failed:', err.message);
        return;
      }
      throw err;
    }
    const assessment = parseAssessment(reply, now);
    if (!assessment) return;

    const state = loadState(guildId, key);
    const harshPref = Boolean(db.getSetting(guildId, 'deesc_harsh_language'));
    const decision = decide(state, assessment, harshPref);
    saveState(guildId, key, decision.state);

    if (decision.state.stage >= 0 && !decision.settled) openChannels.add(key);
    else openChannels.delete(key);

    console.log(`[deesc:${source} ch=${key}] action=${decision.action} | `
      + `${decision.reasons.join('; ')} | ${assessment.summary}`);
    if (decision.action !== 'none') await act(guild, key, decision, assessment);
  } finally {
    running.delete(key);
  }
}

// -- actions (never punitive) -------------------------------------------------

async function act(guild, channelId, decision, assessment) {
  const channel = guild.channels.cache.get(channelId);
  if (!channel) return;

  if (decision.action === 'notify_mods') {
    await logAction(
      guild, 'deescalation', 'Max (de-escalation)', `#${channel.name}`,
      `stage ${decision.state.stage} reached — ${assessment.summary} `
      + `[${decision.reasons.join('; ').slice(0, 300)}]`,
    );
    console.warn(`[deesc] moderators notified for #${channel.name}: ${assessment.summary}`);
    return;
  }

  const text = decision.action === 'check_in' ? CHECK_IN_TEXT : SUGGEST_PAUSE_TEXT;
  try {
    await channel.send(text);
  } catch (err) {
    console.warn('[deesc] send failed:', err.message);
    return;
  }
  if (channel.type === ChannelType.GuildVoice) {
    // Imported lazily: voice.js pulls in the audio stack, and this path only
    // matters when a conflict actually reaches a voice channel.
    try {
      const voice = await import('./voice.js');
      await voice.speakInVoice(guild, text);
    } catch (err) {
      console.warn('[deesc] TTS failed:', err.message);
    }
  }
}

/** Test seam. */
export function _resetForTests() {
  lastAssess.clear();
  openChannels.clear();
  running.clear();
}
