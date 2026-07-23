/**
 * Voice listener sidecar — the "ears" of the hybrid voice-monitoring system.
 *
 * discord.js's voice stack supports Discord's DAVE E2EE protocol (via
 * @snazzah/davey), which no Python library does yet. This process connects
 * with the same bot token as the Python bot (a second gateway session),
 * auto-joins the busiest occupied voice channel per guild, receives each
 * speaker's decrypted audio as a separate stream, cuts utterances on
 * silence, and POSTs raw PCM to the Python bot's internal API. The Python
 * side owns all content decisions (transcription, moderation flags, wake
 * words) and returns TTS audio for this process to play back.
 *
 * Also serves a small control API (POST /join, /leave; GET /status) for the
 * Python bot's owner commands, authed by the shared SECRET_KEY.
 */
'use strict';

const http = require('node:http');
const { Readable } = require('node:stream');
const {
  Client, GatewayIntentBits, Events, ChannelType,
} = require('discord.js');
const {
  joinVoiceChannel, getVoiceConnection, EndBehaviorType,
  createAudioPlayer, createAudioResource, AudioPlayerStatus,
  NoSubscriberBehavior, VoiceConnectionStatus, entersState,
} = require('@discordjs/voice');
const prism = require('prism-media');

const TOKEN = process.env.DISCORD_TOKEN;
const INTERNAL_KEY = process.env.SECRET_KEY || '';
const PY_URL = process.env.PY_URL || `http://127.0.0.1:${process.env.PORT || 8000}`;
const SIDECAR_PORT = parseInt(process.env.SIDECAR_PORT || '8091', 10);

const SILENCE_MS = 1000;              // silence gap that ends an utterance
const MIN_PCM_BYTES = 48000 * 2 * 2 * 0.4; // drop blips under 0.4s
const CONFIG_TTL_MS = 30_000;

if (!TOKEN) {
  console.error('[listener] DISCORD_TOKEN not set, exiting');
  process.exit(1);
}
if (!INTERNAL_KEY) {
  console.error('[listener] SECRET_KEY not set — required to talk to the bot API, exiting');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const activeStreams = new Set();   // "guildId:userId" with a live subscription
const players = new Map();         // guildId -> AudioPlayer
const configCache = new Map();     // guildId -> {at, data}
const manualHold = new Map();      // guildId -> channelId pinned via /join

// -- python API -------------------------------------------------------------

async function pyFetch(path, opts = {}) {
  const res = await fetch(`${PY_URL}/internal${path}`, {
    ...opts,
    headers: { 'x-internal-key': INTERNAL_KEY, ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`python API ${path} -> ${res.status}`);
  const type = res.headers.get('content-type') || '';
  return type.includes('json') ? res.json() : null;
}

async function getConfig(guildId) {
  const cached = configCache.get(guildId);
  if (cached && Date.now() - cached.at < CONFIG_TTL_MS) return cached.data;
  try {
    const data = await pyFetch(`/voice-config?guild_id=${guildId}`);
    configCache.set(guildId, { at: Date.now(), data });
    return data;
  } catch (err) {
    console.error('[listener] config fetch failed:', err.message);
    return cached ? cached.data : { enabled: false };
  }
}

function notifyEvent(guildId, channelId, type) {
  pyFetch('/voice-event', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ guild_id: guildId, channel_id: channelId, type }),
  }).catch((err) => console.error('[listener] event notify failed:', err.message));
}

// -- join/leave orchestration -----------------------------------------------

function humanCount(channel) {
  return channel.members.filter((m) => !m.user.bot).size;
}

function voiceChannels(guild) {
  return guild.channels.cache.filter((c) => c.type === ChannelType.GuildVoice);
}

async function joinChannel(channel) {
  console.log(`[listener] joining #${channel.name} (${channel.id})`);
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });
  connection.receiver.speaking.on('start', (userId) => {
    subscribeUser(connection, channel.guild, userId);
  });
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    // Distinguish a channel move/kick from a network blip
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      connection.destroy();
      const guild = channel.guild;
      setTimeout(() => rebalance(guild).catch(() => {}), 2_000);
    }
  });
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (err) {
    console.error(`[listener] failed to become ready in #${channel.name}:`, err.message);
    connection.destroy();
    return;
  }
  console.log(`[listener] listening in #${channel.name}`);
  notifyEvent(channel.guild.id, channel.id, 'joined');
}

function leaveGuild(guild) {
  const connection = getVoiceConnection(guild.id);
  if (!connection) return;
  const channelId = connection.joinConfig.channelId;
  connection.destroy();
  players.delete(guild.id);
  notifyEvent(guild.id, channelId, 'left');
}

async function rebalance(guild) {
  const cfg = await getConfig(guild.id);
  const connection = getVoiceConnection(guild.id);
  if (!cfg.enabled) {
    if (connection) leaveGuild(guild);
    return;
  }
  const held = manualHold.get(guild.id);
  if (held && connection && connection.joinConfig.channelId === held) return;

  const current = connection && guild.channels.cache.get(connection.joinConfig.channelId);
  if (connection && current && humanCount(current) > 0) return; // stay put
  const occupied = voiceChannels(guild)
    .filter((c) => humanCount(c) > 0)
    .sort((a, b) => humanCount(b) - humanCount(a));
  if (connection) leaveGuild(guild);
  const target = occupied.first();
  if (target) await joinChannel(target);
}

// -- audio receive ----------------------------------------------------------

function subscribeUser(connection, guild, userId) {
  const key = `${guild.id}:${userId}`;
  if (activeStreams.has(key)) return;
  const member = guild.members.cache.get(userId);
  if (member && member.user.bot) return;
  activeStreams.add(key);

  const opusStream = connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_MS },
  });
  const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
  const chunks = [];
  decoder.on('data', (chunk) => chunks.push(chunk));

  const finish = () => {
    if (!activeStreams.delete(key)) return; // already finished
    const pcm = Buffer.concat(chunks);
    if (pcm.length < MIN_PCM_BYTES) return;
    postUtterance(guild, connection.joinConfig.channelId, userId, pcm)
      .catch((err) => console.error('[listener] utterance post failed:', err.message));
  };
  decoder.once('end', finish);
  decoder.once('close', finish);
  decoder.once('error', (err) => { console.error('[listener] decode error:', err.message); finish(); });
  opusStream.once('error', (err) => { console.error('[listener] stream error:', err.message); decoder.destroy(); });
  opusStream.pipe(decoder);
}

async function postUtterance(guild, channelId, userId, pcm) {
  const res = await fetch(`${PY_URL}/internal/utterance`, {
    method: 'POST',
    headers: {
      'x-internal-key': INTERNAL_KEY,
      'x-guild-id': guild.id,
      'x-channel-id': channelId,
      'x-user-id': userId,
      'content-type': 'application/octet-stream',
    },
    body: pcm,
  });
  if (!res.ok) throw new Error(`utterance -> ${res.status}`);
  const data = await res.json();
  if (data && data.tts) playTts(guild, Buffer.from(data.tts, 'base64'));
}

// -- TTS playback -----------------------------------------------------------

function playTts(guild, mp3) {
  const connection = getVoiceConnection(guild.id);
  if (!connection) return;
  let player = players.get(guild.id);
  if (!player) {
    player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    player.on('error', (err) => console.error('[listener] playback error:', err.message));
    players.set(guild.id, player);
  }
  if (player.state.status !== AudioPlayerStatus.Idle) return; // don't talk over ourselves
  connection.subscribe(player);
  player.play(createAudioResource(Readable.from(mp3)));
}

// -- control API for the python bot ----------------------------------------

const control = http.createServer((req, res) => {
  if (req.headers['x-internal-key'] !== INTERNAL_KEY) {
    res.writeHead(401); res.end(); return;
  }
  const reply = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (req.method === 'GET' && req.url === '/status') {
    const conns = client.guilds.cache
      .map((g) => ({ guild: g.id, channel: getVoiceConnection(g.id)?.joinConfig.channelId || null }))
      .filter((c) => c.channel);
    reply(200, { ready: client.isReady(), connections: conns });
    return;
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    try {
      const args = body ? JSON.parse(body) : {};
      const guild = client.guilds.cache.get(String(args.guild_id || ''));
      if (req.method === 'POST' && req.url === '/join') {
        const channel = guild && guild.channels.cache.get(String(args.channel_id || ''));
        if (!channel) { reply(404, { error: 'channel not found' }); return; }
        manualHold.set(guild.id, channel.id);
        const existing = getVoiceConnection(guild.id);
        if (existing) leaveGuild(guild);
        await joinChannel(channel);
        reply(200, { ok: true });
      } else if (req.method === 'POST' && req.url === '/leave') {
        if (!guild) { reply(404, { error: 'guild not found' }); return; }
        manualHold.delete(guild.id);
        leaveGuild(guild);
        reply(200, { ok: true });
      } else {
        reply(404, { error: 'unknown route' });
      }
    } catch (err) {
      console.error('[listener] control error:', err.message);
      reply(500, { error: err.message });
    }
  });
});

// -- wiring -----------------------------------------------------------------

async function rebalanceAll() {
  for (const guild of client.guilds.cache.values()) {
    await rebalance(guild).catch((err) => console.error('[listener] rebalance:', err.message));
  }
}

client.once(Events.ClientReady, () => {
  console.log(`[listener] logged in as ${client.user.tag}, DAVE-capable voice listener up`);
  control.listen(SIDECAR_PORT, '127.0.0.1', () =>
    console.log(`[listener] control API on 127.0.0.1:${SIDECAR_PORT}`));
  // The python bot may still be loading cogs when we come up, so the first
  // config fetches can fail — sweep again shortly, then periodically as a
  // catch-all (also picks up voice_enabled toggles and missed events).
  rebalanceAll();
  for (const delay of [5_000, 15_000]) setTimeout(rebalanceAll, delay);
  setInterval(rebalanceAll, 30_000);
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const member = newState.member || oldState.member;
  if (member && member.user.bot) return;
  const guild = newState.guild || oldState.guild;
  rebalance(guild).catch((err) => console.error('[listener] rebalance:', err.message));
});

process.on('unhandledRejection', (err) => console.error('[listener] unhandled:', err));

client.login(TOKEN);
