// Earcons — the short tones the bot plays into voice to say "I heard my name"
// and "I'm about to answer".
//
// Smart detection made these necessary rather than decorative. Wake words were
// instant and deterministic: you said the phrase, it answered. Detection now
// involves a classifier call and then a reasoning pass that may legitimately
// decide the bot was only being talked ABOUT and stay quiet. Without feedback
// every one of those looks identical from the room: silence. You cannot tell
// "it didn't hear me" from "it heard me and is thinking" from "it heard me and
// decided this wasn't for it" — so people repeat themselves into a bot that is
// already working on an answer.
//
// Synthesized rather than shipped as audio files: a few sine tones with an
// envelope are a handful of lines, they need no asset pipeline, no licensing,
// and no binary in the repo — and they can be retuned by editing numbers.
import { Readable } from 'node:stream';
import {
  createAudioPlayer, createAudioResource, AudioPlayerStatus,
  NoSubscriberBehavior, StreamType, getVoiceConnection,
} from '@discordjs/voice';

// Discord's voice pipeline: 48kHz, stereo, signed 16-bit little-endian.
export const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
// Fade applied to both ends of every segment. A tone that starts or stops at
// a non-zero sample is a step change, and a step change is a click.
const FADE_MS = 12;

/**
 * Render a sequence of tone segments to raw PCM.
 *
 * @param {Array<{freq: number, ms: number, gain?: number}>} segments
 *   freq 0 renders silence, which is how the gap in a two-note chirp is made.
 * @returns {Buffer} 48kHz stereo s16le
 */
export function renderTone(segments) {
  const frames = segments.reduce(
    (total, s) => total + Math.round((s.ms / 1000) * SAMPLE_RATE), 0,
  );
  const buffer = Buffer.alloc(frames * CHANNELS * BYTES_PER_SAMPLE);

  let frame = 0;
  for (const segment of segments) {
    const count = Math.round((segment.ms / 1000) * SAMPLE_RATE);
    const fade = Math.min(Math.round((FADE_MS / 1000) * SAMPLE_RATE), Math.floor(count / 2));
    const gain = segment.gain ?? 0.22;
    for (let i = 0; i < count; i += 1) {
      let value = 0;
      if (segment.freq > 0) {
        // Raised-cosine ramp at each end rather than a linear one — gentler
        // onset, and no discontinuity in the slope either.
        let envelope = 1;
        if (fade > 0 && i < fade) envelope = 0.5 - 0.5 * Math.cos((Math.PI * i) / fade);
        else if (fade > 0 && i >= count - fade) {
          const k = count - 1 - i;
          envelope = 0.5 - 0.5 * Math.cos((Math.PI * k) / fade);
        }
        value = Math.sin((2 * Math.PI * segment.freq * i) / SAMPLE_RATE) * gain * envelope;
      }
      const sample = Math.max(-32768, Math.min(32767, Math.round(value * 32767)));
      const offset = (frame + i) * CHANNELS * BYTES_PER_SAMPLE;
      buffer.writeInt16LE(sample, offset);
      buffer.writeInt16LE(sample, offset + BYTES_PER_SAMPLE);
    }
    frame += count;
  }
  return buffer;
}

// Deliberately quiet and short — this plays over people talking. The shapes
// are meant to be distinguishable without being learned: rising = coming in,
// falling = standing down, flat = noted.
export const EARCONS = {
  // "Your name came up, I'm working out whether that was for me."
  thinking: [{ freq: 587.33, ms: 110, gain: 0.16 }],
  // "I'm answering." Rising minor third, the conventional "opening" shape.
  engaging: [
    { freq: 659.25, ms: 90, gain: 0.2 },
    { freq: 0, ms: 25 },
    { freq: 880.0, ms: 130, gain: 0.2 },
  ],
  // "That wasn't for me — going back to listening." Falling, quieter still,
  // so a wrong guess is cheap rather than annoying.
  declined: [
    { freq: 523.25, ms: 80, gain: 0.12 },
    { freq: 0, ms: 20 },
    { freq: 392.0, ms: 110, gain: 0.12 },
  ],
  // "The follow-up window just closed — say the wake word again." A longer
  // fall than 'declined' and pitched a fifth lower, so the two don't get
  // confused: 'declined' is about one guess, this is the whole conversation
  // ending.
  stopped_listening: [
    { freq: 440.0, ms: 90, gain: 0.16 },
    { freq: 0, ms: 30 },
    { freq: 293.66, ms: 140, gain: 0.16 },
  ],
};

// Rendering is deterministic, so each tone is built once and reused.
const cache = new Map();

export function earconPcm(kind) {
  const segments = EARCONS[kind];
  if (!segments) return null;
  if (!cache.has(kind)) cache.set(kind, renderTone(segments));
  return cache.get(kind);
}

/**
 * Play an earcon into a guild's voice connection.
 *
 * Shares the caller's player so the bot can never play a tone over its own
 * speech, and resolves only once playback is done — a tone is ~250ms, and
 * returning early would have the reply's TTS collide with it.
 *
 * @param {object} guild
 * @param {string} kind  key of EARCONS
 * @param {object} [deps] injection seam for tests
 * @returns {Promise<boolean>} did it actually play
 */
export async function playEarcon(guild, kind, {
  players, connection = getVoiceConnection(guild.id), timeoutMs = 3_000,
} = {}) {
  const pcm = earconPcm(kind);
  if (!pcm || !connection) return false;

  let player = players?.get(guild.id);
  if (!player) {
    player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    player.on('error', (err) => console.error('[earcon] playback error:', err.message));
    players?.set(guild.id, player);
  }
  // Busy means the bot is mid-sentence. A tone on top of its own speech is
  // worse than no tone at all.
  if (player.state.status !== AudioPlayerStatus.Idle) return false;

  connection.subscribe(player);
  player.play(createAudioResource(Readable.from(pcm), { inputType: StreamType.Raw }));

  await new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      player.off(AudioPlayerStatus.Idle, done);
      resolve();
    };
    // The timeout is a backstop against a wedged player holding up a reply,
    // not an expected path.
    const timer = setTimeout(done, timeoutMs);
    player.on(AudioPlayerStatus.Idle, done);
  });
  return true;
}
