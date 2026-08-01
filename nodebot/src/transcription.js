// Speech-to-text — port of transcription.py. Wraps raw Discord voice PCM
// (48kHz, 16-bit, stereo) in a WAV container and posts it to any
// OpenAI-compatible /audio/transcriptions endpoint.
import { TRANSCRIPTION_API_KEY, TRANSCRIPTION_API_URL, TRANSCRIPTION_MODEL } from './config.js';

// Retries for transient upstream failures (Cloudflare 502s in front of the
// API, rate limits, dropped connections). Deliberately short and few — a
// wake word answered ten seconds late is worse than one missed.
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 400;

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const SAMPLE_WIDTH = 2;

// Whisper tends to hallucinate these on silence/noise-only clips.
const JUNK = new Set([
  'you', 'bye', 'bye bye', 'bye-bye', 'thank you', 'thanks',
  'thank you very much', 'thank you so much', 'thank you for watching',
  'thanks for watching', 'subscribe', 'please subscribe',
  'see you next time', 'see you in the next video', '.', 'the',
  'okay', 'ok', 'yeah', 'yes', 'no', 'uh', 'um', 'hmm', 'mm-hmm', 'mm',
  'oh', 'ah', 'huh', 'so', 'you know', 'silence', 'music',
]);

export function available() {
  return Boolean(TRANSCRIPTION_API_KEY);
}

/** Wrap raw PCM in a minimal WAV (RIFF/PCM) container. */
export function pcmToWav(pcm) {
  const header = Buffer.alloc(44);
  const byteRate = SAMPLE_RATE * CHANNELS * SAMPLE_WIDTH;
  const blockAlign = CHANNELS * SAMPLE_WIDTH;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);           // fmt chunk size
  header.writeUInt16LE(1, 20);            // PCM format
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(SAMPLE_WIDTH * 8, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Transcribe one utterance of raw PCM. Returns "" for silence/junk/errors. */
export async function transcribePcm(pcm) {
  if (!available() || !pcm || !pcm.length) return '';
  const url = `${TRANSCRIPTION_API_URL.replace(/\/$/, '')}/audio/transcriptions`;
  const form = new FormData();
  form.append('file', new Blob([pcmToWav(pcm)], { type: 'audio/wav' }), 'utterance.wav');
  form.append('model', TRANSCRIPTION_MODEL);
  form.append('response_format', 'json');

  // A failed transcription is a lost utterance — Max simply never hears what
  // was said, with nothing to tell the speaker why. Transient upstream
  // failures are common enough to be worth a couple of quick retries: a
  // Cloudflare 502 in front of the API, a 429, a dropped connection. Kept
  // short and few, because a wake word answered ten seconds late is worse
  // than one missed.
  let resp = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      resp = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TRANSCRIPTION_API_KEY}` },
        body: form,
      });
    } catch (err) {
      resp = null;
      if (attempt === MAX_ATTEMPTS) {
        console.warn('[transcription] request failed:', err.message);
        return '';
      }
    }
    if (resp?.ok) break;

    const status = resp?.status;
    const retryable = !resp || RETRYABLE_STATUSES.has(status);
    if (!retryable || attempt === MAX_ATTEMPTS) {
      if (resp) {
        // eslint-disable-next-line no-await-in-loop
        console.warn(`[transcription] API ${status}: ${(await resp.text()).slice(0, 200)}`);
      }
      return '';
    }
    console.warn(`[transcription] ${status ?? 'network error'} — retrying (${attempt}/${MAX_ATTEMPTS - 1})`);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, RETRY_BACKOFF_MS * attempt); });
  }
  if (!resp?.ok) return '';

  let text;
  try {
    text = ((await resp.json()).text || '').trim();
  } catch {
    return '';
  }
  if (JUNK.has(text.replace(/[.!?,\s]+$/, '').toLowerCase())) return '';
  return text;
}
