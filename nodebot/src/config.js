import 'dotenv/config';
// phrases.js imports nothing, so this cannot cycle back through config.
import { parsePhraseList } from './phrases.js';

// Process start stamp — stamped into dashboard asset URLs to defeat browser
// caching, and shown as the dashboard build id.
export const BUILD_ID = String(Math.floor(Date.now() / 1000));

// Dashboard: password login and the key that signs session cookies. Same
// env var names as the Python bot.
export const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
// Discord OAuth for dashboard login ("Sign in with Discord"). Without the
// secret, login stays password-only. Discord Developer Portal → your app →
// OAuth2 → Client Secret, and add <PUBLIC_URL>/api/auth/callback under Redirects.
export const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
// Public origin of the dashboard, e.g. https://max.up.railway.app. Only needed
// when the reverse proxy rewrites Host; otherwise it is derived per request.
export const PUBLIC_URL = process.env.PUBLIC_URL || '';
export const SECRET_KEY = process.env.SECRET_KEY || '';
export const PORT = parseInt(process.env.PORT || '8000', 10);

export const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
export const CLIENT_ID = process.env.CLIENT_ID || '';
export const OWNER_ID = process.env.OWNER_ID || '';
export const DEV_GUILD_ID = process.env.DEV_GUILD_ID || '';

export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
export const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'anthropic/claude-3.5-haiku';
// Model for background work — memory upkeep, signal classification,
// de-escalation assessments. That's the large majority of call volume and
// none of it needs the conversational model. "openrouter/free" routes
// across OpenRouter's free-model pool at $0.
export const OPENROUTER_UTILITY_MODEL = process.env.OPENROUTER_UTILITY_MODEL || 'openrouter/free';
// Spend breaker: hard cap on background model calls per hour (0 = uncapped).
export const OPENROUTER_BG_HOURLY_CAP = parseInt(process.env.OPENROUTER_BG_HOURLY_CAP || '240', 10);

// GitHub read access. The token is optional — without it the API still
// works anonymously at 60 requests/hour instead of 5000. GITHUB_REPO is the
// repo Max lives in, which is what the branch/PR/diff tools read.
export const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
export const GITHUB_REPO = process.env.GITHUB_REPO || 'seed0001/discord-agent';

// Web search: duck-duck-scrape is blocked from most cloud/datacenter IPs
// (Railway included). BRAVE_SEARCH_API_KEY enables full Brave Web Search;
// without it, web_search falls back to DuckDuckGo's limited instant-answer API.
export const BRAVE_SEARCH_API_KEY = process.env.BRAVE_SEARCH_API_KEY || '';

// Speech-to-text: any OpenAI-compatible /audio/transcriptions endpoint
// (OpenAI Whisper, Groq, ...) — same env vars as the Python bot.
export const TRANSCRIPTION_API_KEY = process.env.TRANSCRIPTION_API_KEY || '';
export const TRANSCRIPTION_API_URL = process.env.TRANSCRIPTION_API_URL || 'https://api.openai.com/v1';
export const TRANSCRIPTION_MODEL = process.env.TRANSCRIPTION_MODEL || 'whisper-1';

// TTS: Fish Audio when set, edge-tts (free, via msedge-tts) as fallback.
export const FISH_API_KEY = process.env.FISH_API_KEY || '';
export const FISH_TTS_MODEL = process.env.FISH_TTS_MODEL || 's2.1-pro-free';
export const FISH_VOICE_ID = process.env.FISH_VOICE_ID || '';
// Microsoft Edge neural voice when Fish Audio is not configured — any
// name from https://speech.microsoft.com/portal/voicegallery (e.g.
// en-US-JennyNeural, en-US-GuyNeural).
export const EDGE_TTS_VOICE = process.env.EDGE_TTS_VOICE || 'en-US-JennyNeural';

// Env-configured fallback defaults (used to seed db.js's DEFAULTS) — the
// live, per-guild values come from db.getSetting(guildId, 'voice_wake_words'
// / 'voice_cancel_words') once a guild has its own settings row.
//
// parsePhraseList accepts both forms, so these env vars take either the
// bracket form the dashboard now uses — [hey max] [max, you around?] — or the
// original comma-separated list. Brackets are the one to reach for when a
// phrase needs a comma in it.
export const VOICE_WAKE_WORDS = parsePhraseList(
  process.env.VOICE_WAKE_WORDS || 'hey max,hey andrew',
);
export const VOICE_CANCEL_WORDS = parsePhraseList(
  process.env.VOICE_CANCEL_WORDS
  || 'never mind,nevermind,forget it,forget about it,cancel that,scratch that',
);

// Follow-up mode end phrases. Two different things, deliberately:
// "stop speaking" is barge-in (shut up now, but stay in the conversation);
// "stop listening" ends the conversation (finish the sentence, then go back
// to needing the wake word).
//
// Written already-normalized (lowercase, no punctuation) so they read the way
// they are stored and shown back on the dashboard. All multi-word too, since
// matching is substring-based and a bare "stop" would fire inside "stopping".
export const VOICE_STOP_SPEAKING_WORDS = parsePhraseList(
  process.env.VOICE_STOP_SPEAKING_WORDS
  || 'max stop speaking,max stop talking,stop speaking max,stop talking max,'
  + 'max be quiet,max shut up,max quiet down',
);
export const VOICE_STOP_LISTENING_WORDS = parsePhraseList(
  process.env.VOICE_STOP_LISTENING_WORDS
  || 'max stop listening,stop listening max,max go to sleep,max we are done,'
  + 'max that is all,thanks max that is all',
);

// Which of the phrase lists above were actually pinned in the environment.
//
// The built-in defaults are written around the name "max", so when nobody has
// configured anything botName.js derives them from the bot's real name
// instead — "amy stop speaking" rather than a stop word that can never fire.
// That is only safe when the value here is a fallback rather than a choice
// someone made, which is exactly what this records.
export const VOICE_PHRASES_FROM_ENV = {
  voice_wake_words: Boolean(process.env.VOICE_WAKE_WORDS),
  voice_cancel_words: Boolean(process.env.VOICE_CANCEL_WORDS),
  voice_stop_speaking_words: Boolean(process.env.VOICE_STOP_SPEAKING_WORDS),
  voice_stop_listening_words: Boolean(process.env.VOICE_STOP_LISTENING_WORDS),
};

// How long after the bot finishes speaking it keeps answering without the wake
// word. 0 disables follow-up mode outright. Per-guild override lives in
// db.js DEFAULTS as voice_followup_window_sec.
export const VOICE_FOLLOWUP_WINDOW_SEC = parseInt(
  process.env.VOICE_FOLLOWUP_WINDOW_SEC || '25', 10,
);

// Voice noise gate — utterances shorter than MIN_UTTERANCE_SEC seconds, or
// quieter than MIN_UTTERANCE_RMS (0-32768), are dropped as background-noise
// blips. Same env var names (and same defaults) the listener sidecar used,
// so tuning already set in the deployment carries over untouched.
export const MIN_UTTERANCE_SEC = parseFloat(process.env.MIN_UTTERANCE_SEC || '1.5');
export const MIN_UTTERANCE_RMS = parseInt(process.env.MIN_UTTERANCE_RMS || '300', 10);

// SQLite file path for the persistence layer (db.js).
export const DATABASE_PATH = process.env.DATABASE_PATH || 'nodebot.db';
