// Voice: join/leave/rebalance is a direct port of listener/index.js's
// proven logic (DAVE E2EE join, per-speaker capture, silence-cut
// utterances) — no reason to rewrite working audio-plumbing code. What's
// new here is that content decisions (transcribe, wake word, reply, TTS)
// happen in THIS SAME process and read/write conversation.js's shared
// buffer — the same one textChat.js uses. That's the actual fix for the
// Python bot's split: there is no longer an HTTP hop and no longer a
// second, separate transcript the model's context doesn't include.
import { Readable } from 'node:stream';
import { ChannelType } from 'discord.js';
import {
  joinVoiceChannel, getVoiceConnection, EndBehaviorType,
  createAudioPlayer, createAudioResource, AudioPlayerStatus,
  NoSubscriberBehavior, VoiceConnectionStatus, entersState,
} from '@discordjs/voice';
import prism from 'prism-media';

import { MIN_UTTERANCE_SEC, MIN_UTTERANCE_RMS } from './config.js';
import { chat, OpenRouterError } from './openrouter.js';
import { InsufficientCreditsError } from './credits/index.js';
import * as switching from './backends/switching.js';
import { recordTurn, formatForPrompt } from './conversation.js';
import { VOICE_PROMPT, VOICE_OWNER_ACTION_NOTE, VOICE_PASS, COMPANION_STANCE_NOTE } from './persona.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { normalizePhrase } from './phrases.js';
import { botName, voicePhrases } from './botName.js';
import { detectMention } from './mention.js';
import { playCue } from './cues.js';
import * as transcription from './transcription.js';
import * as tts from './tts.js';
import { TOOL_SCHEMAS, runTool } from './tools.js';
import { KB_TOOL_SCHEMAS, runTool as runKbTool } from './knowledge.js';
import * as channelBrains from './channelBrains.js';
import * as agentTools from './agentTools.js';
import * as calendar from './calendar.js';
import * as mediaTools from './mediaTools.js';
import * as musicTools from './musicTools.js';
import * as voiceTools from './voiceTools.js';
import * as github from './github.js';
import * as memory from './memory.js';
import { REPO_TOOL_SCHEMAS, runRepoTool } from './textChat.js';
import { isOwner } from './utils.js';
import * as db from './db.js';

const SILENCE_MS = 1000;                 // silence gap that ends an utterance
// Noise gate thresholds come from the environment (see config.js) rather
// than being hardcoded here, so the tuning already in the deployment for
// the listener sidecar keeps working under the same variable names.
const MIN_PCM_BYTES = 48000 * 2 * 2 * MIN_UTTERANCE_SEC;
const MIN_RMS = MIN_UTTERANCE_RMS;        // loudness floor
const STUCK_CONNECTION_MS = 60_000;
const WAKE_COOLDOWN_MS = 8_000;
const WAKE_GRACE_MS = 1_000;              // window for an instant "never mind"
// Ceiling on waiting for TTS playback to finish before arming the follow-up
// window. Only a backstop against a wedged player — a spoken reply is
// seconds, not minutes.
const PLAYBACK_WAIT_MS = 120_000;
const REPEAT_SUPPRESS_MS = 45_000;
const REPEAT_MAX_CHARS = 30;
// Fallback stop phrases that work without the bot's name, used only while
// it is already engaged (a pending wake or an open follow-up window). The
// configured voice_stop_listening_words / voice_stop_speaking_words default
// to name-prefixed forms ("max stop listening"), which is the right call
// for waking it from cold — but nobody says a wake word mid-conversation to
// end one, so a bare "stop listening" was falling through to the LLM, which
// would answer in character ("okay, I'll stop listening") without the
// window actually closing. Not name-gated at all times because that would
// make ordinary background chatter ("shut up", "that's all") a false
// trigger whenever the bot isn't already listening for anyone.
export const ENGAGED_STOP_SPEAKING_WORDS = ['stop speaking', 'stop talking', 'be quiet', 'shut up', 'quiet down'];
export const ENGAGED_STOP_LISTENING_WORDS = [
  'stop listening', 'we are done', "we're done", 'that is all', "that's all",
];
// Name-free "leave voice for good" fallback — same idea as the two lists
// above (only consulted once the bot is already engaged), kept separate
// because leaving the channel is a bigger action than ending a follow-up.
export const ENGAGED_LEAVE_WORDS = [
  'go to sleep', 'leave the voice channel', 'leave voice', 'leave the call',
  'drop from voice', 'you can go now',
];
const CONTEXT_TURNS = 40;
// Context handed to the stage-1 mention classifier. Much smaller than
// CONTEXT_TURNS: it only needs enough to tell a name from a similar word,
// and this prompt runs far more often than the conversational one.
const MENTION_CONTEXT_TURNS = 6;
const MAX_TOOL_ROUNDS = 4;
const OWNER_MAX_TOOL_ROUNDS = 8;

// Short, spoken-friendly blurbs for the "on it" announcement that plays
// before a chained action actually runs, keyed by agentTools tool name —
// ported from the Python bot's voice.py _ACTION_BLURBS.
const ACTION_BLURBS = {
  kick_member: (a) => `kicking ${a.user}`,
  ban_member: (a) => `banning ${a.user}`,
  unban_user: (a) => `unbanning user ${a.user_id}`,
  timeout_member: (a) => `timing out ${a.user} for ${a.minutes} minutes`,
  untimeout_member: (a) => `removing ${a.user}'s timeout`,
  warn_member: (a) => `warning ${a.user}`,
  clear_warnings: (a) => `clearing ${a.user}'s warnings`,
  purge_messages: (a) => `deleting ${a.amount} messages${a.channel ? ` in #${a.channel}` : ''}`,
  set_slowmode: (a) => `setting slowmode to ${a.seconds}s${a.channel ? ` in #${a.channel}` : ''}`,
  lock_channel: (a) => `${a.locked === false ? 'unlocking' : 'locking'}${a.channel ? ` #${a.channel}` : ' this channel'}`,
  create_channel: (a) => `creating a ${a.kind || 'text'} channel called ${a.name}`,
  delete_channel: (a) => `deleting #${a.channel}`,
  set_channel_topic: (a) => `updating the topic${a.channel ? ` for #${a.channel}` : ''}`,
  send_message: (a) => `posting that${a.channel ? ` in #${a.channel}` : ''}`,
  give_role: (a) => `giving ${a.user} the ${a.role} role`,
  take_role: (a) => `removing the ${a.role} role from ${a.user}`,
  create_role: (a) => `creating the ${a.name} role`,
  delete_role: (a) => `deleting the ${a.role} role`,
  play_playlist: () => 'starting the playlist',
  play_song: (a) => (a.song ? `playing ${a.song}` : 'playing that for you'),
  stop_music: () => 'stopping the music',
  save_song: (a) => `saving that as "${a.title}"`,
  delete_song: (a) => `removing "${a.song}" from the library`,
  calendar_add: (a) => `scheduling a reminder${a.title ? ` for ${a.title}` : ''}`,
  calendar_update: (a) => `updating reminder ${a.id}`,
  calendar_cancel: (a) => `cancelling reminder ${a.id}`,
};

/** Turn raw OpenRouter tool_calls into one short, speakable "on it" line,
 * so the owner hears what's about to happen before it happens, not just
 * the after-the-fact result. */
export function describeToolCalls(toolCalls) {
  const parts = toolCalls.map((call) => {
    let args = {};
    try {
      args = JSON.parse(call.function?.arguments || '{}');
    } catch { /* malformed args from the model — fall through to generic */ }
    const blurb = ACTION_BLURBS[call.function?.name];
    return blurb ? blurb(args) : 'handling that';
  });
  if (!parts.length) return 'on it, one sec.';
  return `on it — ${parts.join(', then ')}.`;
}

const activeStreams = new Set();     // "guildId:userId" with a live subscription
const players = new Map();           // guildId -> AudioPlayer
const playlists = new Map();         // guildId -> { songs: [...], index: 0, active: true }
const manualHold = new Map();        // guildId -> channelId pinned via a join command
const notReadySince = new Map();     // guildId -> ms timestamp connection left Ready
const lastWake = new Map();          // channelId -> ms timestamp
const lastText = new Map();          // userId -> [normalizedText, ms timestamp]
const pendingWake = new Map();       // channelId -> { cancelled, controller }
const followUpUntil = new Map();     // channelId -> ms timestamp the window shuts
// Bumped whenever a window is force-closed. respond() captures the value on
// entry and armFollowUp() refuses to re-arm if it has changed since — so
// "Max, stop listening" said while he is still speaking actually sticks,
// instead of being undone by the arm that fires when playback ends.
const followUpEpoch = new Map();     // channelId -> int
// The natural-expiry tone: armFollowUp() sets one for `seconds` out whenever
// it opens a window, so the room hears the same "stopped listening" cue
// whether the window timed out or someone said the words. Re-arming or an
// explicit close both replace/clear this before it fires, so it only ever
// goes off once per window.
const followUpTimer = new Map();     // channelId -> Timeout
// Companion voice sessions (companion/session.js) inject a compact
// relationship context packet here for the duration of one session; empty
// for every guild that isn't mid companion-session, so this is a no-op for
// everyone else. See setCompanionContext() below and its read site in
// respond().
const companionContext = new Map(); // guildId -> context packet text

/** Give the next voice turn(s) in this guild the companion relationship
 *  context packet (REL/PATTERN/OPEN/STANCE/INTENT), or clear it with
 *  `text` falsy. Read by respond() when assembling the system prompt. */
export function setCompanionContext(guildId, text) {
  const key = String(guildId);
  if (text) companionContext.set(key, text);
  else companionContext.delete(key);
}

/** Is the follow-up window open on this channel — i.e. can someone speak to
 * Max right now without saying the wake word? */
export function isFollowUpOpen(channelId, now = Date.now()) {
  return now < (followUpUntil.get(channelId) || 0);
}

/** Open (or extend) the window: for the next `seconds`, anyone in this
 * channel is talking to Max without needing the wake word. */
export function openFollowUp(channelId, seconds, now = Date.now()) {
  if (!(seconds > 0)) return false;
  followUpUntil.set(channelId, now + seconds * 1000);
  return true;
}

/** End the conversation: back to requiring the wake word. */
export function closeFollowUp(channelId) {
  followUpUntil.delete(channelId);
  followUpEpoch.set(channelId, (followUpEpoch.get(channelId) || 0) + 1);
  const timer = followUpTimer.get(channelId);
  if (timer) {
    clearTimeout(timer);
    followUpTimer.delete(channelId);
  }
}

/** Play the "he's stopped listening" cue. Shared by the natural-expiry timer
 * and the explicit "stop listening" phrase so both sound identical. */
async function announceStoppedListening(guild, channel) {
  try {
    await playCue(guild, channel, 'stopped_listening', { players });
  } catch (err) {
    console.error('[voice] stopped-listening cue failed:', err?.message || err);
  }
}

/** Cut Max off mid-sentence: kill playback and abort anything in flight.
 * Deliberately leaves the follow-up window alone — "stop speaking" means
 * drop this answer, not leave the conversation. */
export function stopSpeaking(guild, channelId) {
  const pending = pendingWake.get(channelId);
  if (pending) {
    pending.cancelled = true;
    clearTimeout(pending.timer);
    pending.controller?.abort();
    pendingWake.delete(channelId);
  }
  // "Stop speaking" also means "stop the music" — a song or playlist is just
  // the other thing that can be coming out of this same player.
  const playlist = playlists.get(guild.id);
  if (playlist) playlist.active = false;
  playlists.delete(guild.id);
  const player = players.get(guild.id);
  if (player && player.state.status !== AudioPlayerStatus.Idle) player.stop(true);
}

function humanCount(channel) {
  return channel.members.filter((m) => !m.user.bot).size;
}

function voiceChannels(guild) {
  return guild.channels.cache.filter((c) => c.type === ChannelType.GuildVoice);
}

/** Empty allowlist = unrestricted (same convention as ai_channels). */
function isChannelAllowed(channel) {
  const allowlist = db.getSetting(channel.guild.id, 'voice_channel_allowlist') || [];
  if (allowlist.length === 0 || allowlist.includes(channel.id)) return true;
  // The Private Companion Room (companion/scheduler.js) is a separate,
  // explicit admin choice made through its own dedicated picker (which
  // already checks it's private and bot-usable) — being selected there IS
  // the permission decision. Requiring it to ALSO be added to the general
  // ambient-monitoring allowlist above is a different concern (which
  // channels get always-listening AI monitoring) and silently blocked every
  // companion join with reason=not-allowed.
  return db.getSetting(channel.guild.id, 'companion_room_channel_id') === channel.id;
}

export function matchesAny(text, words) {
  // Both sides get normalized. Normalizing only the transcript — which this
  // did until phrases could contain punctuation — meant any phrase with a
  // comma or apostrophe in it could never match: "Max, are you there?"
  // normalizes to "max are you there", which does not contain the literal
  // needle "max, are you there".
  const normalized = normalizePhrase(text);
  if (!normalized) return false;
  return (words || []).some((w) => {
    const needle = normalizePhrase(w);
    return needle && normalized.includes(needle);
  });
}

// -- join/leave/rebalance (ported from listener/index.js) -------------------

async function joinChannel(channel) {
  if (!isChannelAllowed(channel)) {
    console.log(`[voice] refusing to join #${channel.name} (${channel.id}) — not in voice_channel_allowlist`);
    return false;
  }
  console.log(`[voice] joining #${channel.name} (${channel.id})`);
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });
  connection.receiver.speaking.on('start', (userId) => {
    subscribeUser(connection, channel.guild, channel, userId);
  });
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      connection.destroy();
      // A companion voice session ends itself on a real connection loss
      // rather than being left "conversing" forever. Lazy import avoids a
      // load-time cycle (companion/session.js imports voice.js).
      if (companionContext.has(String(channel.guild.id))) {
        import('./companion/session.js')
          .then((session) => session.handleConnectionLost(channel.guild))
          .catch((err) => console.error('[voice] companion connection-lost hook failed:', err.message));
      }
      setTimeout(() => rebalance(channel.guild).catch(() => {}), 2_000);
    }
  });
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (err) {
    console.error(`[voice] failed to become ready in #${channel.name}:`, err.message);
    connection.destroy();
    return false;
  }
  console.log(`[voice] listening in #${channel.name}`);
  const wakeWords = voicePhrases(channel.client, channel.guild.id, 'voice_wake_words');
  const hint = wakeWords.length ? ` Say "${wakeWords[0]}" to bring me into the conversation.` : '';
  try {
    await channel.send(`🎙️ Heads-up: an AI is listening to this channel and transcribing speech.${hint}`);
  } catch (err) {
    console.warn('[voice] join announcement failed:', err.message);
  }
  return true;
}

function leaveGuild(guild) {
  const connection = getVoiceConnection(guild.id);
  if (!connection) return;
  // Leaving ends any conversation that was still live, so rejoining later
  // starts from the wake word rather than answering the first thing it hears.
  for (const c of voiceChannels(guild).values()) closeFollowUp(c.id);
  connection.destroy();
  players.delete(guild.id);
  playlists.delete(guild.id);
}

async function rebalance(guild) {
  let connection = getVoiceConnection(guild.id);

  if (db.getSetting(guild.id, 'quiet_mode')) {
    if (connection) leaveGuild(guild);
    return;
  }

  // Told to leave and stay out (a "go to sleep" phrase, the leave_voice tool,
  // or the dashboard stop button). Cleared by "join us in voice" or the
  // dashboard — until then the sweep does not touch voice.
  if (db.getSetting(guild.id, 'voice_sleep')) {
    if (connection) leaveGuild(guild);
    return;
  }

  // Zombie detection: a connection stuck out of Ready (dead UDP, missed
  // disconnect event) is silently deaf — tear it down and rejoin.
  if (connection) {
    if (connection.state.status === VoiceConnectionStatus.Ready) {
      notReadySince.delete(guild.id);
    } else {
      const since = notReadySince.get(guild.id) || Date.now();
      notReadySince.set(guild.id, since);
      if (Date.now() - since > STUCK_CONNECTION_MS) {
        console.warn(`[voice] connection stuck in '${connection.state.status}' — rebuilding`);
        notReadySince.delete(guild.id);
        leaveGuild(guild);
        connection = null;
      } else {
        return; // still within grace period, give it time to recover
      }
    }
  }

  const held = manualHold.get(guild.id);
  if (held) {
    const heldChannel = guild.channels.cache.get(held);
    if (!heldChannel || humanCount(heldChannel) === 0) {
      manualHold.delete(guild.id); // pinned channel emptied — resume auto mode
    } else if (connection && connection.joinConfig.channelId === held) {
      return;
    }
  }

  const current = connection && guild.channels.cache.get(connection.joinConfig.channelId);
  if (connection && current && humanCount(current) > 0) return; // stay put
  const occupied = voiceChannels(guild)
    .filter((c) => humanCount(c) > 0 && isChannelAllowed(c))
    .sort((a, b) => humanCount(b) - humanCount(a));
  if (connection) leaveGuild(guild);
  const target = occupied.first();
  if (target) await joinChannel(target);
}

export async function rebalanceAll(client) {
  for (const guild of client.guilds.cache.values()) {
    await rebalance(guild).catch((err) => console.error('[voice] rebalance:', err.message));
  }
}

export function init(client) {
  if (!transcription.available()) {
    console.warn('[voice] TRANSCRIPTION_API_KEY not set — voice monitoring disabled');
    return;
  }
  rebalanceAll(client);
  for (const delay of [5_000, 15_000]) setTimeout(() => rebalanceAll(client), delay);
  setInterval(() => rebalanceAll(client), 30_000);
}

export function handleVoiceStateUpdate(oldState, newState) {
  const member = newState.member || oldState.member;
  if (member?.user.bot) return;
  const guild = newState.guild || oldState.guild;
  rebalance(guild).catch((err) => console.error('[voice] rebalance:', err.message));
}

// -- audio receive ------------------------------------------------------------

function pcmRms(buf) {
  const samples = Math.floor(buf.length / 2);
  if (!samples) return 0;
  const step = Math.max(1, Math.floor(samples / 4000));
  let sum = 0;
  let count = 0;
  for (let i = 0; i < samples; i += step) {
    const v = buf.readInt16LE(i * 2);
    sum += v * v;
    count += 1;
  }
  return Math.sqrt(sum / count);
}

function subscribeUser(connection, guild, channel, userId) {
  const key = `${guild.id}:${userId}`;
  if (activeStreams.has(key)) return;
  const member = guild.members.cache.get(userId);
  if (member?.user.bot) return;
  activeStreams.add(key);

  const opusStream = connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_MS },
  });
  const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
  const chunks = [];
  decoder.on('data', (chunk) => chunks.push(chunk));

  const watchdog = setTimeout(() => {
    console.warn(`[voice] subscription watchdog fired for user ${userId}`);
    try { opusStream.destroy(); } catch { /* already gone */ }
    try { decoder.destroy(); } catch { /* already gone */ }
    finish();
  }, 90_000);

  const finish = () => {
    clearTimeout(watchdog);
    if (!activeStreams.delete(key)) return; // already finished
    const pcm = Buffer.concat(chunks);
    if (pcm.length < MIN_PCM_BYTES) return; // too short — noise blip
    const rms = pcmRms(pcm);
    if (rms < MIN_RMS) {
      console.log(`[voice] dropped quiet blip (rms ${Math.round(rms)}) from ${userId}`);
      return;
    }
    handleUtterance(guild, channel, userId, pcm)
      .catch((err) => console.error('[voice] utterance handling failed:', err.message));
  };
  decoder.once('end', finish);
  decoder.once('close', finish);
  decoder.once('error', (err) => { console.error('[voice] decode error:', err.message); finish(); });
  opusStream.once('error', (err) => { console.error('[voice] stream error:', err.message); decoder.destroy(); });
  opusStream.pipe(decoder);
}

// -- content: transcribe, remember, wake word, reply -------------------------

async function handleUtterance(guild, channel, userId, pcm) {
  // Muted — rebalance() will leave the channel on its next sweep; drop
  // until then rather than race a reply out during the gap.
  if (db.getSetting(guild.id, 'quiet_mode')) return;
  const member = guild.members.cache.get(userId);
  if (member?.user.bot) return;
  const name = member?.displayName || `user-${userId}`;

  const text = await transcription.transcribePcm(pcm, { guildId: guild.id });
  if (!text) return;

  // Resolved before the repeat suppressor below, which would otherwise eat
  // them: "max stop" is well under REPEAT_MAX_CHARS, so saying it twice in a
  // row — exactly what someone does when the first one seems not to have
  // landed — would see the second discarded as a noise blip.
  //
  // "engaged" widens the match to the name-free fallback list — see
  // ENGAGED_STOP_LISTENING_WORDS above for why that's safe here but not
  // unconditionally.
  const engaged = Boolean(pendingWake.get(channel.id)) || isFollowUpOpen(channel.id);
  const stopsSpeaking = matchesAny(text, voicePhrases(guild.client, guild.id, 'voice_stop_speaking_words'))
    || (engaged && matchesAny(text, ENGAGED_STOP_SPEAKING_WORDS));
  const stopsListening = matchesAny(text, voicePhrases(guild.client, guild.id, 'voice_stop_listening_words'))
    || (engaged && matchesAny(text, ENGAGED_STOP_LISTENING_WORDS));
  const leavesVoice = matchesAny(text, voicePhrases(guild.client, guild.id, 'voice_leave_words'))
    || (engaged && matchesAny(text, ENGAGED_LEAVE_WORDS));

  // Repeated short phrases from the same user in quick succession are
  // noise-gate hallucinations, not someone actually talking.
  const normalized = text.toLowerCase().split(/\s+/).join(' ');
  const prev = lastText.get(userId);
  const now = Date.now();
  if (!stopsSpeaking && !stopsListening && !leavesVoice
      && prev && prev[0] === normalized && normalized.length <= REPEAT_MAX_CHARS
      && now - prev[1] < REPEAT_SUPPRESS_MS) {
    lastText.set(userId, [normalized, now]);
    console.log(`[voice] dropped repeated blip from ${name}: ${text}`);
    return;
  }
  lastText.set(userId, [normalized, now]);
  console.log(`[voice] [#${channel.name}] ${name}: ${text}`);

  recordTurn(guild.id, { source: 'voice', channel: channel.name, speaker: name, text });
  memory.recordTurn(guild.id, name, text, {
    source: 'voice', userId, channel: channel.name,
  });
  // Voice transcripts feed the pressure classifier too, so proactive speech
  // sees what was said out loud, not just what was typed.
  import('./proactive.js')
    .then((proactive) => proactive.feedVoice(guild, channel.id, userId, name, text))
    .catch((err) => console.error('[voice] pressure feed failed:', err?.message || err));

  // "B" / "switch to Haiku" / "switch back" — answering a pending backend
  // offer. No wake word needed: she just asked a question out loud and is
  // waiting for the answer, and requiring "hey Max, B" after that would be
  // absurd. Matched with plain string work, because the backend that would
  // interpret it is the one that is down.
  const answer = switching.resolveOffer(guild.id, text);
  if (answer) {
    const reply = switching.applyAnswer(guild.id, answer);
    console.log(`[voice] backend switch by voice: ${text} → ${reply}`);
    recordTurn(guild.id, {
      source: 'voice', channel: channel.name, speaker: botName(guild.client, guild.id), text: reply,
    });
    await speakInVoice(guild, reply);
    return;
  }

  // "Max, stop speaking" — barge in. Kills playback and anything in flight,
  // but stays in the conversation, so the next thing said still reaches him.
  if (stopsSpeaking) {
    stopSpeaking(guild, channel.id);
    console.log(`[voice] [#${channel.name}] cut off by ${name}: ${text}`);
    return;
  }

  // "Max, go to sleep" — leave voice entirely and stay out. More than
  // stop-listening: the connection is dropped and voice_sleep is set so the
  // rebalance sweep won't rejoin. Checked before stopsListening because the
  // leave phrases are the more specific intent.
  if (leavesVoice) {
    console.log(`[voice] [#${channel.name}] told to leave by ${name}: ${text}`);
    closeFollowUp(channel.id);
    db.setSetting(guild.id, 'voice_sleep', true);
    try {
      await channel.send('👋 Leaving voice — ask me back any time ("join us in voice").');
    } catch { /* best effort */ }
    // Say goodbye, let it finish playing, then disconnect.
    const spoke = await speakInVoice(guild, 'alright, later.');
    if (spoke) {
      const player = players.get(guild.id);
      if (player) {
        try { await entersState(player, AudioPlayerStatus.Idle, 8_000); } catch { /* overran */ }
      }
    }
    leaveGuild(guild);
    return;
  }

  // "Max, stop listening" — end the conversation. Whatever is already
  // playing gets to finish its sentence; what stops is him treating the next
  // utterance as his to answer.
  if (stopsListening) {
    const wasOpen = isFollowUpOpen(channel.id);
    closeFollowUp(channel.id);
    console.log(`[voice] [#${channel.name}] follow-up ended by ${name}: ${text}`);
    if (wasOpen) announceStoppedListening(guild, channel);
    return;
  }

  // Cancel words abort a pending wake response ("never mind, Max").
  const pending = pendingWake.get(channel.id);
  const cancelWords = voicePhrases(guild.client, guild.id, 'voice_cancel_words');
  if (pending && !pending.cancelled && matchesAny(text, cancelWords)) {
    pending.cancelled = true;
    clearTimeout(pending.timer);
    pending.controller?.abort();
    pendingWake.delete(channel.id);
    console.log(`[voice] [#${channel.name}] wake response cancelled by ${name}: ${text}`);
    return;
  }

  // An exact wake word always wins: zero latency, zero cost, and it is what
  // someone reaching for a known phrase expects. Everything else depends on
  // the detection mode.
  const wakeWords = voicePhrases(guild.client, guild.id, 'voice_wake_words');
  const woken = matchesAny(text, wakeWords);
  const followUp = !woken && isFollowUpOpen(channel.id, now);

  if ((woken || followUp) && (!pending || pending.cancelled)) {
    scheduleResponse(channel, name, userId, { followUp });
    return;
  }
  // A cancelled pending is a "never mind" that already returned above; only a
  // LIVE one should suppress detection.
  if (woken || followUp || (pending && !pending.cancelled)) return;

  // Smart detection. Stage 1 only asks "did the bot's name come up at all",
  // deliberately erring towards yes; stage 2 (inside respond) is what decides
  // whether that was someone talking TO it or ABOUT it. Running the pass
  // itself is gated on a live conversation being absent — inside a follow-up
  // window the bot is already listening and this would be redundant work.
  if (db.getSetting(guild.id, 'voice_detection_mode') !== 'smart') return;
  if (!db.getSetting(guild.id, 'ai_enabled')) return;
  if (db.getSetting(guild.id, 'quiet_mode')) return;
  // respond() enforces the same cooldown, but checking it only there would
  // mean spending a classifier call and playing an "I'm thinking" cue for a
  // reply that then gets silently dropped — worse than not reacting at all.
  if (now - (lastWake.get(channel.id) || 0) < WAKE_COOLDOWN_MS) return;

  detectMention(guild, channel.id, text, {
    transcript: formatForPrompt(guild.id, MENTION_CONTEXT_TURNS),
  }).then(async (verdict) => {
    if (!verdict.mentioned) return;
    if (pendingWake.get(channel.id) || isFollowUpOpen(channel.id)) return;
    console.log(`[voice] [#${channel.name}] mention detected via ${verdict.via}`
      + `${verdict.heard ? ` ("${verdict.heard}")` : ''}: ${text}`);
    // Acknowledge before the slow part. The reasoning pass can take a couple
    // of seconds and may end in a deliberate silence, so without this the
    // room cannot tell it was heard at all.
    await playCue(guild, channel, 'thinking', { players });
    scheduleResponse(channel, name, userId, { mention: verdict.heard || text });
  }).catch((err) => console.error('[voice] mention detection failed:', err?.message || err));
}

/** Arm a reply after the grace window, so an immediate "never mind" can still
 *  cancel it. Shared by the wake-word, follow-up and smart-detection paths so
 *  all three cancel and de-duplicate identically. */
function scheduleResponse(channel, name, userId, opts) {
  const state = { cancelled: false, controller: null, timer: null };
  state.timer = setTimeout(() => {
    if (state.cancelled) return;
    respond(channel, name, userId, state, opts)
      .catch((err) => console.error('[voice] wake response failed:', err.message))
      .finally(() => { if (pendingWake.get(channel.id) === state) pendingWake.delete(channel.id); });
  }, WAKE_GRACE_MS);
  pendingWake.set(channel.id, state);
}

/** Re-open the follow-up window once Max has actually finished speaking.
 *
 * Timed off the end of playback, not the end of generation: speakInVoice()
 * returns the moment playback starts, so arming there would spend most of a
 * 25-second window on a 20-second answer and leave five seconds to reply. */
export async function armFollowUp(channel, spoke, epoch) {
  const guild = channel.guild;
  if (!db.getSetting(guild.id, 'voice_followup_enabled')) return;
  const seconds = Number(db.getSetting(guild.id, 'voice_followup_window_sec')) || 0;
  if (seconds <= 0) return;

  if (spoke) {
    const player = players.get(guild.id);
    if (player && player.state.status !== AudioPlayerStatus.Idle) {
      try {
        await entersState(player, AudioPlayerStatus.Idle, PLAYBACK_WAIT_MS);
      } catch {
        // Playback overran the ceiling or errored out. Arm anyway — the
        // worse failure is Max going deaf after a glitched reply.
      }
    }
  }
  // Someone said "stop listening" while that was playing. Honour it.
  if ((followUpEpoch.get(channel.id) || 0) !== epoch) return;

  openFollowUp(channel.id, seconds);
  console.log(`[voice] [#${channel.name}] listening for a follow-up for ${seconds}s`);

  const existingTimer = followUpTimer.get(channel.id);
  if (existingTimer) clearTimeout(existingTimer);
  followUpTimer.set(channel.id, setTimeout(() => {
    followUpTimer.delete(channel.id);
    // Only announce if nothing re-armed or force-closed the window since —
    // both of those already replaced/cleared this timer, but the check is a
    // cheap backstop against a race between clearTimeout and the callback.
    if (!isFollowUpOpen(channel.id)) {
      announceStoppedListening(guild, channel);
      // The follow-up window closing on its own IS the "silence" end trigger
      // for a companion voice session — session.js listens here rather than
      // running its own silence timer. No-op for every guild not mid a
      // companion session (session.js checks before acting).
      if (companionContext.has(String(guild.id))) {
        import('./companion/session.js')
          .then((session) => session.handleSilenceTimeout(guild, channel))
          .catch((err) => console.error('[voice] companion silence hook failed:', err.message));
      }
    }
  }, seconds * 1000));
}

/** The current follow-up epoch for a channel — see followUpEpoch above.
 *  Exposed so companion/session.js can arm the initial follow-up window
 *  right after speaking its opening line without racing a stale snapshot. */
export function currentFollowUpEpoch(channelId) {
  return followUpEpoch.get(channelId) || 0;
}

async function respond(channel, speakerName, speakerId, state, { followUp = false, mention = null } = {}) {
  const now = Date.now();
  // The wake cooldown exists to stop wake-word spam, and inside a live
  // conversation it would do the opposite of its job: eight seconds is the
  // normal rhythm of back-and-forth, so it would swallow the follow-up that
  // is the whole point — and swallow it silently.
  if (!followUp && now - (lastWake.get(channel.id) || 0) < WAKE_COOLDOWN_MS) return;
  lastWake.set(channel.id, now);
  const epoch = followUpEpoch.get(channel.id) || 0;

  const guild = channel.guild;
  const owner = isOwner(speakerId);
  // A fresh wake word or mention (not just continuing an already-open
  // follow-up window) is a deliberate reciprocity signal for the companion
  // system — see textChat.js's matching @mention hook. Lazy import: this
  // file is what companion/session.js imports, so a static import here
  // would be a load-time cycle. No-op for every guild without companion
  // mode on.
  if (!followUp) {
    import('./companion/session.js')
      .then((session) => session.recordDeliberateContact(guild.id, speakerId, 'voice'))
      .catch((err) => console.error('[voice] companion mention reciprocity failed:', err.message));
  }
  // The name the bot speaks under in the shared conversation buffer. Text
  // chat records its own turns under the live Discord name, so hardcoding
  // anything here would put one bot in the transcript under two names.
  const self = botName(channel.client, guild.id);
  const model = db.getSetting(guild.id, 'ai_model');
  // Same assembly text chat uses — character persona, the real command list,
  // capabilities, owner/member note — so the two surfaces describe the same
  // bot. Voice-specific framing is appended after it. The memory block is the
  // same one text chat gets: the speaker's profile card first, then
  // guild-wide durable/working memory.
  const memoryBlock = memory.getContext(guild.id, speakerId);

  // message.author on a real discord.js Message is a User, not a
  // GuildMember — match that shape so agentTools' actor()/checks behave
  // the same here as they do from text chat. Built before the prompt
  // rather than after it because mediaTools.allowed() needs a message to
  // resolve per-guild generation access, and that answer has to be known
  // while the system prompt is still being assembled.
  const fakeMessage = {
    guild, channel,
    member: guild.members.cache.get(speakerId) || null,
    author: guild.members.cache.get(speakerId)?.user
      || { id: speakerId, tag: speakerName, username: speakerName },
  };
  const canGenerate = await mediaTools.allowed(fakeMessage);
  // Music is gated separately and more narrowly (admin/server owner/bot
  // owner only, never open to 'everyone') — see musicTools.allowed.
  const canMakeMusic = await musicTools.allowed(fakeMessage);
  let systemPrompt = buildSystemPrompt({
    client: channel.client, guild, owner, memory: memoryBlock, media: canGenerate, music: canMakeMusic,
  }) + VOICE_PROMPT({
    channel: channel.name, speaker: speakerName, followUp, mention,
  });
  if (owner) systemPrompt += VOICE_OWNER_ACTION_NOTE;
  // Companion relationship context, only present for the duration of one
  // companion/session.js voice session — see setCompanionContext() above.
  const companionNote = companionContext.get(String(guild.id));
  if (companionNote) systemPrompt += `\n\n${COMPANION_STANCE_NOTE}\n\n${companionNote}`;
  // What's in reach to play, so he can offer a track without calling
  // list_songs first — only when this speaker can actually work the music.
  if (canMakeMusic) {
    try {
      systemPrompt += await musicTools.voiceMusicContext(fakeMessage);
    } catch (err) {
      console.warn('[voice] music context failed:', err?.message || err);
    }
  }
  const transcript = formatForPrompt(guild.id, CONTEXT_TURNS);

  const baseTools = [
    ...TOOL_SCHEMAS, ...KB_TOOL_SCHEMAS, memory.RECALL_TOOL_SCHEMA,
    ...github.GITHUB_TOOL_SCHEMAS, ...REPO_TOOL_SCHEMAS,
    ...calendar.CALENDAR_TOOL_SCHEMAS,
    ...voiceTools.TOOL_SCHEMAS,
  ];
  // Generation is not an owner privilege the way moderation is — a guild can
  // open it to everyone — so the media schemas ride on canGenerate alone.
  const tools = [
    ...baseTools,
    ...(owner ? agentTools.TOOL_SCHEMAS : []),
    ...(canGenerate ? mediaTools.TOOL_SCHEMAS : []),
    ...(canMakeMusic ? musicTools.TOOL_SCHEMAS : []),
    ...(channelBrains.enabled() ? channelBrains.TOOL_SCHEMAS : []),
    ...(channelBrains.enabled() && owner ? channelBrains.OWNER_TOOL_SCHEMAS : []),
  ];
  const toolHandler = async (name, args) => {
    if (name === 'recall_chat_log') return memory.recall(guild.id, args);
    if (name.startsWith('github_')) return github.runGithubTool(name, args);
    if (name.startsWith('repo_')) return runRepoTool(name, args);
    if (name.startsWith('kb_')) return runKbTool(guild.id, name, args);
    // Open to everyone: calendar.execute re-checks its own owner-only bits.
    if (calendar.isCalendarTool(name)) return calendar.execute(fakeMessage, name, args, owner);
    if (voiceTools.isVoiceTool(name)) return voiceTools.execute(null, fakeMessage, name, args);
    if (owner && name in agentTools.TOOLS) return agentTools.execute(null, fakeMessage, name, args);
    // No owner check: mediaTools.execute re-checks access itself, so gating
    // here would only duplicate it — and get it wrong for open guilds.
    if (name in mediaTools.TOOLS) return mediaTools.execute(null, fakeMessage, name, args);
    // Same shape: execute re-checks the admin/owner gate on music itself.
    if (name in musicTools.TOOLS) return musicTools.execute(null, fakeMessage, name, args);
    // Same shape: execute re-checks the owner gate on index/delete itself.
    if (channelBrains.isChannelBrainsTool(name)) return channelBrains.execute(name, args, owner);
    return runTool(name, args);
  };
  let headsUpGiven = false;
  const onToolCalls = (owner || canGenerate || canMakeMusic) ? async (toolCalls) => {
    headsUpGiven = true;
    const blurb = describeToolCalls(toolCalls);
    recordTurn(guild.id, { source: 'voice', channel: channel.name, speaker: self, text: blurb });
    try {
      await channel.send(blurb);
    } catch (err) {
      console.warn('[voice] "on it" announcement post failed:', err.message);
    }
    await speakInVoice(guild, blurb);
  } : undefined;

  state.controller = new AbortController();
  let reply;
  try {
    reply = await chat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `[voice transcript of #${channel.name}]\n${transcript}` },
    ], {
      model,
      signal: state.controller.signal,
      tools, toolHandler, onToolCalls,
      maxToolRounds: owner ? OWNER_MAX_TOOL_ROUNDS : MAX_TOOL_ROUNDS,
      guildId: guild.id,
    });
  } catch (err) {
    if (state.cancelled) return; // aborted by a cancel word — expected
    // Nothing spoken. Transcription has already gone quiet for the same
    // reason, so the room simply stops getting answers; the text channel is
    // where the reason gets said.
    if (err instanceof InsufficientCreditsError) return;
    // Rate limited — say so out loud and offer alternatives, rather than
    // going silent and leaving the room wondering whether she heard them.
    if (err instanceof OpenRouterError && err.status === 429) {
      const options = switching.shortlist(guild.id, 'chat');
      if (options.length) {
        switching.offer(guild.id, 'chat', options);
        await speakInVoice(guild, switching.offerText(err.model || model, options));
        try {
          await channel.send(switching.offerText(err.model || model, options));
        } catch { /* the spoken version is the one that matters */ }
        return;
      }
    }
    // The "on it" heads-up already told the room to expect a follow-up — if
    // the loop then fails, silence here would leave that promise hanging
    // (console.warn is invisible from Discord). Say so plainly instead,
    // whatever the failure turns out to be.
    if (headsUpGiven) {
      const failureNote = "sorry — something went wrong finishing that.";
      await speakInVoice(guild, failureNote);
      try {
        await channel.send(failureNote);
      } catch { /* the spoken version is the one that matters */ }
    }
    if (err instanceof OpenRouterError) {
      console.warn('[voice] wake response failed:', err.message);
      return;
    }
    throw err;
  }
  if (state.cancelled || !reply) return;

  // Follow-up mode hands him every utterance in the channel, including two
  // other people talking to each other. Declining is a valid outcome, and it
  // deliberately does NOT re-arm the window: only a real answer extends the
  // conversation, so idle chatter lets it lapse instead of holding it open
  // (and billing for it) indefinitely.
  if ((followUp || mention) && isPass(reply)) {
    // Stage 2 decided this was the bot being talked ABOUT, not to. That is a
    // correct outcome, but from the room it is indistinguishable from not
    // having heard — so say so, quietly, if the guild wants it.
    console.log(`[voice] [#${channel.name}] not addressed to ${self} — passing`);
    await playCue(guild, channel, 'declined', { players });
    return;
  }

  // A companion voice session can end itself here: the persona note
  // (COMPANION_STANCE_NOTE, only present when companionNote was appended
  // above) tells the model to end a reply with this marker when it wants to
  // wrap up. It's one of several independent session-end triggers (see
  // companion/session.js) — a deterministic code decision reacting to a
  // small signal, never a dependency the whole feature rests on. Stripped
  // before anything gets posted or spoken either way.
  const companionEnded = Boolean(companionNote) && /\[\[end_session\]\]/i.test(reply);
  const display = (tts.stripVoiceTags(reply) || reply).replace(/\[\[end_session\]\]/gi, '').trim();
  // "Coming in now." Played before the text post and the TTS, so the cue
  // leads the reply rather than trailing it. playCue resolves once the tone
  // has finished, which is also what keeps it from colliding with speech.
  await playCue(guild, channel, 'engaging', { players });
  recordTurn(guild.id, { source: 'voice', channel: channel.name, speaker: self, text: display });
  // userId null: the bot doesn't get a profile card built about itself.
  memory.recordTurn(guild.id, self, display, {
    source: 'voice', userId: null, channel: channel.name,
  });
  try {
    for (let i = 0; i < display.length; i += 1990) {
      await channel.send(display.slice(i, i + 1990));
    }
  } catch (err) {
    console.warn('[voice] posting reply failed:', err.message);
  }
  const spoke = await speakInVoice(guild, display);
  if (companionEnded) {
    try {
      const session = await import('./companion/session.js');
      await session.handleModelEnded(guild);
    } catch (err) {
      console.error('[voice] companion session-end hook failed:', err.message);
    }
  } else {
    await armFollowUp(channel, spoke, epoch);
  }
}

/** Did the model decline to answer? Tolerant of the trailing punctuation and
 * stray formatting models add to a one-word reply, but still strict enough
 * that a real sentence merely containing the word can't be swallowed. */
export function isPass(reply) {
  return new RegExp(`^[\\s"'*_.]*${VOICE_PASS}[\\s"'*_.!]*$`, 'i').test(reply);
}

// -- TTS playback -------------------------------------------------------------

export async function speakInVoice(guild, text) {
  const connection = getVoiceConnection(guild.id);
  if (!connection) return false;
  const audio = await tts.synthesize(text, { guildId: guild.id });
  if (!audio) return false;
  let player = players.get(guild.id);
  if (!player) {
    player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    player.on('error', (err) => console.error('[voice] playback error:', err.message));
    players.set(guild.id, player);
  }
  if (player.state.status !== AudioPlayerStatus.Idle) return false; // don't talk over ourselves
  connection.subscribe(player);
  player.play(createAudioResource(Readable.from(audio)));
  return true;
}

// -- song-library playback ----------------------------------------------------
// Shares the same AudioPlayer TTS uses (the `players` map) rather than a
// second one, for two reasons: only one thing should ever come out of the
// bot's mouth in a channel at a time, and it means stopSpeaking() — what
// "Max, stop speaking/listening" already calls — stops music for free
// instead of needing its own path.

// How long to wait for the player to fall Idle before giving up on starting
// playback. Set from musicTools.js's own tool-call flow: voice.js's respond()
// speaks a short "on it" announcement (e.g. "starting the playlist") the
// instant the model decides to call play_song/play_playlist, and that
// speakInVoice() call returns as soon as playback STARTS, not when it ends —
// so without this wait, the busy check below would see the announcement
// still playing a beat later and refuse to start, right after promising to.
const ANNOUNCE_WAIT_MS = 10_000;

/** The voice channel this guild's connection is sitting in right now, or null
 * if the bot isn't connected. Used by musicTools.js to work out who is in
 * earshot — the DJ path only pulls from the libraries of people actually in
 * the channel. */
export function currentVoiceChannel(guild) {
  const connection = getVoiceConnection(guild.id);
  const channelId = connection?.joinConfig?.channelId;
  return channelId ? (guild.channels.cache.get(channelId) || null) : null;
}

/** Start playing a list of {title, data, mediaType} songs back to back in
 * this guild's current voice channel. Returns false — does nothing — if the
 * bot isn't connected, or the player is still busy after ANNOUNCE_WAIT_MS
 * (a spoken reply in progress, or a track already queued); callers should
 * tell the user to try stop_music first rather than silently cutting off
 * whatever that busy state actually is. */
export async function playInVoice(guild, songs) {
  const connection = getVoiceConnection(guild.id);
  if (!connection || !songs?.length) return false;
  let player = players.get(guild.id);
  if (!player) {
    player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    player.on('error', (err) => console.error('[voice] playback error:', err.message));
    players.set(guild.id, player);
  }
  if (player.state.status !== AudioPlayerStatus.Idle) {
    try {
      await entersState(player, AudioPlayerStatus.Idle, ANNOUNCE_WAIT_MS);
    } catch {
      return false;
    }
  }
  connection.subscribe(player);
  const state = { songs, index: 0, active: true };
  playlists.set(guild.id, state);
  playNextSong(guild, player, state);
  return true;
}

function playNextSong(guild, player, state) {
  if (!state.active || state.index >= state.songs.length) {
    if (playlists.get(guild.id) === state) playlists.delete(guild.id);
    return;
  }
  const song = state.songs[state.index];
  const onStateChange = (oldStatus, newStatus) => {
    if (newStatus.status !== AudioPlayerStatus.Idle) return;
    player.off('stateChange', onStateChange);
    if (playlists.get(guild.id) !== state || !state.active) return; // stopped mid-track
    state.index += 1;
    playNextSong(guild, player, state);
  };
  player.on('stateChange', onStateChange);
  player.play(createAudioResource(Readable.from(song.data)));
}

/** Stop whatever song or playlist is currently playing and drop back to plain
 * listening. Returns whether anything was actually stopped. */
export function stopMusic(guild) {
  const playlist = playlists.get(guild.id);
  if (playlist) playlist.active = false;
  playlists.delete(guild.id);
  const player = players.get(guild.id);
  if (player && player.state.status !== AudioPlayerStatus.Idle) {
    player.stop(true);
    return true;
  }
  return false;
}

// -- owner control (join/leave a specific channel) ---------------------------

/** Returns false if the channel isn't in voice_channel_allowlist, so the
 * caller (the /voicejoin command) can tell the requester why nothing happened. */
export async function joinRequestedChannel(channel) {
  if (!isChannelAllowed(channel)) return false;
  manualHold.set(channel.guild.id, channel.id);
  const existing = getVoiceConnection(channel.guild.id);
  if (existing) leaveGuild(channel.guild);
  return joinChannel(channel);
}

export function leaveRequestedGuild(guild) {
  manualHold.delete(guild.id);
  leaveGuild(guild);
}

// -- conversational presence control (join_voice / leave_voice tools) --------

/** Leave voice and stay out until asked back — the tool/dashboard equivalent
 * of a "go to sleep" phrase. Sets voice_sleep so the rebalance sweep won't
 * rejoin. */
export function sleepGuild(guild) {
  db.setSetting(guild.id, 'voice_sleep', true);
  manualHold.delete(guild.id);
  leaveGuild(guild);
}

/**
 * Clear the "stay out" flag and get back into voice.
 *
 * With a channel: join that one (respecting voice_channel_allowlist, same as
 * /voicejoin). Without: run a rebalance so the bot picks the busiest occupied
 * allowed channel right now.
 *
 * @returns {Promise<{joined: boolean, channel: string|null, reason?: string}>}
 */
export async function wakeGuild(guild, channel = null) {
  db.setSetting(guild.id, 'voice_sleep', false);
  if (channel) {
    const ok = await joinRequestedChannel(channel);
    return ok
      ? { joined: true, channel: channel.name }
      : { joined: false, channel: null, reason: 'not-allowed' };
  }
  await rebalance(guild);
  const current = currentVoiceChannel(guild);
  return current
    ? { joined: true, channel: current.name }
    : { joined: false, channel: null, reason: 'no-one-in-voice' };
}

/** Test seam: drop all in-process follow-up state. */
export function _resetForTests() {
  followUpUntil.clear();
  followUpEpoch.clear();
  for (const timer of followUpTimer.values()) clearTimeout(timer);
  followUpTimer.clear();
  lastWake.clear();
  lastText.clear();
  pendingWake.clear();
  playlists.clear();
}
