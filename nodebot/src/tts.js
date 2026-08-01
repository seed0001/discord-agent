// TTS synthesis — port of tts.py. Fish Audio when FISH_API_KEY is set, with
// msedge-tts (free, unofficial Edge Read Aloud API) as the fallback.
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { EDGE_TTS_VOICE, FISH_API_KEY, FISH_TTS_MODEL, FISH_VOICE_ID } from './config.js';

const FISH_URL = 'https://api.fish.audio/v1/tts';

// S1's fixed tag vocabulary (emotions, tones, effects) — same list the
// model is prompted with; used here only to strip tags for text display.
const S1_TAGS = [
  'angry', 'sad', 'disdainful', 'excited', 'surprised', 'satisfied',
  'unhappy', 'anxious', 'hysterical', 'delighted', 'scared', 'worried',
  'indifferent', 'upset', 'impatient', 'nervous', 'guilty', 'scornful',
  'frustrated', 'depressed', 'panicked', 'furious', 'empathetic',
  'embarrassed', 'reluctant', 'disgusted', 'keen', 'moved', 'proud',
  'relaxed', 'grateful', 'confident', 'interested', 'curious', 'confused',
  'joyful', 'disapproving', 'negative', 'denying', 'astonished', 'serious',
  'sarcastic', 'conciliative', 'comforting', 'sincere', 'sneering',
  'hesitating', 'yielding', 'painful', 'awkward', 'amused',
  'in a hurry tone', 'shouting', 'screaming', 'whispering', 'soft tone',
  'laughing', 'chuckling', 'sobbing', 'crying loudly', 'sighing',
  'panting', 'groaning', 'break', 'long-break', 'breath',
  'laugh', 'cough', 'sigh', 'lip-smacking',
];
const TAG_RE = new RegExp(
  `\\((?:${[...S1_TAGS].sort((a, b) => b.length - a.length).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\)\\s*`,
  'ig',
);
// S2 models take free-form [bracketed] voice directions anywhere in the text.
const S2_TAG_RE = /\[[^[\]\n]{1,60}\]\s*/g;

export function fishEnabled() {
  return Boolean(FISH_API_KEY);
}

export function isS2() {
  return FISH_TTS_MODEL.toLowerCase().startsWith('s2');
}

export function stripVoiceTags(text) {
  return text.replace(TAG_RE, '').replace(S2_TAG_RE, '').trim();
}

// Per-request text budget for each backend. A longer reply is split at
// sentence boundaries and synthesized piece by piece, then the MP3s are
// concatenated — MP3 is a stream of self-contained frames, so joining the
// bytes plays back as one continuous clip. That keeps the single-blob
// contract speakInVoice() expects while letting a multi-paragraph reply be
// spoken in full; both backends used to hard-slice and drop the remainder.
const FISH_CHUNK = 1500;
const EDGE_CHUNK = 700;
// Ceiling on synthesis calls per reply, so a runaway answer can't fan out
// into dozens of API requests. Hitting it is logged, never silent.
const MAX_CHUNKS = 8;

/** Split text into <=limit pieces, preferring sentence/paragraph breaks. */
export function splitForTts(text, limit) {
  const pieces = String(text).split(/(?<=[.!?])\s+|\n+/).filter((p) => p.trim());
  const chunks = [];
  let cur = '';
  for (let piece of pieces) {
    // A single sentence longer than the budget still has to be broken up.
    while (piece.length > limit) {
      if (cur) { chunks.push(cur); cur = ''; }
      chunks.push(piece.slice(0, limit));
      piece = piece.slice(limit);
    }
    if (!cur) cur = piece;
    else if (cur.length + 1 + piece.length <= limit) cur += ` ${piece}`;
    else { chunks.push(cur); cur = piece; }
  }
  if (cur.trim()) chunks.push(cur);
  return chunks;
}

async function synthesizeWith(text, limit, backend, label) {
  let chunks = splitForTts(text, limit);
  if (!chunks.length) return null;
  if (chunks.length > MAX_CHUNKS) {
    console.warn(`[tts] reply needs ${chunks.length} ${label} chunks — speaking the first ${MAX_CHUNKS}`);
    chunks = chunks.slice(0, MAX_CHUNKS);
  }
  const parts = [];
  for (const chunk of chunks) {
    const audio = await backend(chunk);
    if (!audio) return null; // fall through to the next backend for the whole reply
    parts.push(audio);
  }
  return Buffer.concat(parts);
}

/** Returns audio bytes (Buffer) for text, or null if no TTS backend works. */
export async function synthesize(text) {
  if (fishEnabled()) {
    const audio = await synthesizeWith(text, FISH_CHUNK, fish, 'Fish');
    if (audio) return audio;
  }
  return synthesizeWith(stripVoiceTags(text), EDGE_CHUNK, edge, 'edge');
}

async function fish(text) {
  const payload = { text, format: 'mp3', latency: 'normal' };
  if (FISH_VOICE_ID) payload.reference_id = FISH_VOICE_ID;
  let resp;
  try {
    resp = await fetch(FISH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${FISH_API_KEY}`,
        'Content-Type': 'application/json',
        model: FISH_TTS_MODEL,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.warn('[tts] Fish Audio request failed:', err.message);
    return null;
  }
  if (!resp.ok) {
    console.warn(`[tts] Fish Audio ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    return null;
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  return buf.length ? buf : null;
}

async function edge(text) {
  try {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(EDGE_TTS_VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(text);
    const chunks = [];
    for await (const chunk of audioStream) chunks.push(chunk);
    const buf = Buffer.concat(chunks);
    return buf.length ? buf : null;
  } catch (err) {
    console.log('[tts] edge-tts unavailable:', err.message);
    return null;
  }
}
