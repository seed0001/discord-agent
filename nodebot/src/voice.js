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
import { recordTurn, formatForPrompt } from './conversation.js';
import { VOICE_PROMPT, VOICE_OWNER_ACTION_NOTE, VOICE_PASS } from './persona.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { normalizePhrase } from './phrases.js';
import * as transcription from './transcription.js';
import * as tts from './tts.js';
import { TOOL_SCHEMAS, runTool } from './tools.js';
import { KB_TOOL_SCHEMAS, runTool as runKbTool } from './knowledge.js';
import * as agentTools from './agentTools.js';
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
const CONTEXT_TURNS = 40;
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
  const player = players.get(guild.id);
  if (player && player.state.status !== AudioPlayerStatus.Idle) player.stop(true);
}

function humanCount(channel) {
  return channel.members.filter((m) => !m.user.bot).size;
}

function voiceChannels(guild) {
  return guild.channels.cache.filter((c) => c.type === ChannelType.GuildVoice);
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
      setTimeout(() => rebalance(channel.guild).catch(() => {}), 2_000);
    }
  });
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (err) {
    console.error(`[voice] failed to become ready in #${channel.name}:`, err.message);
    connection.destroy();
    return;
  }
  console.log(`[voice] listening in #${channel.name}`);
  const wakeWords = db.getSetting(channel.guild.id, 'voice_wake_words');
  const hint = wakeWords.length ? ` Say "${wakeWords[0]}" to bring me into the conversation.` : '';
  try {
    await channel.send(`🎙️ Heads-up: an AI is listening to this channel and transcribing speech.${hint}`);
  } catch (err) {
    console.warn('[voice] join announcement failed:', err.message);
  }
}

function leaveGuild(guild) {
  const connection = getVoiceConnection(guild.id);
  if (!connection) return;
  // Leaving ends any conversation that was still live, so rejoining later
  // starts from the wake word rather than answering the first thing it hears.
  for (const c of voiceChannels(guild).values()) closeFollowUp(c.id);
  connection.destroy();
  players.delete(guild.id);
}

async function rebalance(guild) {
  let connection = getVoiceConnection(guild.id);

  if (db.getSetting(guild.id, 'quiet_mode')) {
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
    .filter((c) => humanCount(c) > 0)
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

  const text = await transcription.transcribePcm(pcm);
  if (!text) return;

  // Resolved before the repeat suppressor below, which would otherwise eat
  // them: "max stop" is well under REPEAT_MAX_CHARS, so saying it twice in a
  // row — exactly what someone does when the first one seems not to have
  // landed — would see the second discarded as a noise blip.
  const stopsSpeaking = matchesAny(text, db.getSetting(guild.id, 'voice_stop_speaking_words'));
  const stopsListening = matchesAny(text, db.getSetting(guild.id, 'voice_stop_listening_words'));

  // Repeated short phrases from the same user in quick succession are
  // noise-gate hallucinations, not someone actually talking.
  const normalized = text.toLowerCase().split(/\s+/).join(' ');
  const prev = lastText.get(userId);
  const now = Date.now();
  if (!stopsSpeaking && !stopsListening
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

  // "Max, stop speaking" — barge in. Kills playback and anything in flight,
  // but stays in the conversation, so the next thing said still reaches him.
  if (stopsSpeaking) {
    stopSpeaking(guild, channel.id);
    console.log(`[voice] [#${channel.name}] cut off by ${name}: ${text}`);
    return;
  }

  // "Max, stop listening" — end the conversation. Whatever is already
  // playing gets to finish its sentence; what stops is him treating the next
  // utterance as his to answer.
  if (stopsListening) {
    closeFollowUp(channel.id);
    console.log(`[voice] [#${channel.name}] follow-up ended by ${name}: ${text}`);
    return;
  }

  // Cancel words abort a pending wake response ("never mind, Max").
  const pending = pendingWake.get(channel.id);
  const cancelWords = db.getSetting(guild.id, 'voice_cancel_words');
  if (pending && !pending.cancelled && matchesAny(text, cancelWords)) {
    pending.cancelled = true;
    clearTimeout(pending.timer);
    pending.controller?.abort();
    pendingWake.delete(channel.id);
    console.log(`[voice] [#${channel.name}] wake response cancelled by ${name}: ${text}`);
    return;
  }

  // Either the wake word, or the conversation is already live and this is
  // just the next thing someone said.
  const wakeWords = db.getSetting(guild.id, 'voice_wake_words');
  const woken = matchesAny(text, wakeWords);
  const followUp = !woken && isFollowUpOpen(channel.id, now);
  if ((woken || followUp) && (!pending || pending.cancelled)) {
    const state = { cancelled: false, controller: null, timer: null };
    state.timer = setTimeout(() => {
      if (state.cancelled) return;
      respond(channel, name, userId, state, { followUp })
        .catch((err) => console.error('[voice] wake response failed:', err.message))
        .finally(() => { if (pendingWake.get(channel.id) === state) pendingWake.delete(channel.id); });
    }, WAKE_GRACE_MS);
    pendingWake.set(channel.id, state);
  }
}

/** Re-open the follow-up window once Max has actually finished speaking.
 *
 * Timed off the end of playback, not the end of generation: speakInVoice()
 * returns the moment playback starts, so arming there would spend most of a
 * 25-second window on a 20-second answer and leave five seconds to reply. */
async function armFollowUp(channel, spoke, epoch) {
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
}

async function respond(channel, speakerName, speakerId, state, { followUp = false } = {}) {
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
  const model = db.getSetting(guild.id, 'ai_model');
  // Same assembly text chat uses — character persona, the real command list,
  // capabilities, owner/member note — so the two surfaces describe the same
  // bot. Voice-specific framing is appended after it. The memory block is the
  // same one text chat gets: the speaker's profile card first, then
  // guild-wide durable/working memory.
  const memoryBlock = memory.getContext(guild.id, speakerId);
  let systemPrompt = buildSystemPrompt({
    client: channel.client, guild, owner, memory: memoryBlock,
  }) + VOICE_PROMPT({ channel: channel.name, speaker: speakerName, followUp });
  if (owner) systemPrompt += VOICE_OWNER_ACTION_NOTE;
  const transcript = formatForPrompt(guild.id, CONTEXT_TURNS);

  // message.author on a real discord.js Message is a User, not a
  // GuildMember — match that shape so agentTools' actor()/checks behave
  // the same here as they do from text chat.
  const fakeMessage = {
    guild, channel,
    author: guild.members.cache.get(speakerId)?.user
      || { id: speakerId, tag: speakerName, username: speakerName },
  };
  const baseTools = [
    ...TOOL_SCHEMAS, ...KB_TOOL_SCHEMAS, memory.RECALL_TOOL_SCHEMA,
    ...github.GITHUB_TOOL_SCHEMAS, ...REPO_TOOL_SCHEMAS,
  ];
  const tools = owner ? [...baseTools, ...agentTools.TOOL_SCHEMAS] : baseTools;
  const toolHandler = async (name, args) => {
    if (name === 'recall_chat_log') return memory.recall(guild.id, args);
    if (name.startsWith('github_')) return github.runGithubTool(name, args);
    if (name.startsWith('repo_')) return runRepoTool(name, args);
    if (name.startsWith('kb_')) return runKbTool(guild.id, name, args);
    if (owner && name in agentTools.TOOLS) return agentTools.execute(null, fakeMessage, name, args);
    return runTool(name, args);
  };
  const onToolCalls = owner ? async (toolCalls) => {
    const blurb = describeToolCalls(toolCalls);
    recordTurn(guild.id, { source: 'voice', channel: channel.name, speaker: 'Max', text: blurb });
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
    });
  } catch (err) {
    if (state.cancelled) return; // aborted by a cancel word — expected
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
  if (followUp && isPass(reply)) {
    console.log(`[voice] [#${channel.name}] not addressed to Max — passing`);
    return;
  }

  const display = tts.stripVoiceTags(reply) || reply;
  recordTurn(guild.id, { source: 'voice', channel: channel.name, speaker: 'Max', text: display });
  // userId null: Max doesn't get a profile card built about himself.
  memory.recordTurn(guild.id, 'Max', display, {
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
  await armFollowUp(channel, spoke, epoch);
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
  const audio = await tts.synthesize(text);
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

// -- owner control (join/leave a specific channel) ---------------------------

export async function joinRequestedChannel(channel) {
  manualHold.set(channel.guild.id, channel.id);
  const existing = getVoiceConnection(channel.guild.id);
  if (existing) leaveGuild(channel.guild);
  await joinChannel(channel);
}

export function leaveRequestedGuild(guild) {
  manualHold.delete(guild.id);
  leaveGuild(guild);
}

/** Test seam: drop all in-process follow-up state. */
export function _resetForTests() {
  followUpUntil.clear();
  followUpEpoch.clear();
  lastWake.clear();
  lastText.clear();
  pendingWake.clear();
}
