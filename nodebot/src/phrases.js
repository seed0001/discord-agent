// Phrase lists — wake words, cancel words, and the two stop-word lists.
//
// These are entered on the dashboard as bracketed phrases:
//
//     [hey max] [hey andrew] [max, you around?]
//
// rather than as a comma-separated list, so a phrase can contain a comma.
// That was the whole reason for the change: "max, are you there" is one
// phrase, not two.
//
// Parsing lives here, server-side, rather than in the browser: it is the
// fiddly half (unclosed brackets, the old comma format, normalization) and
// this way there is one implementation with tests behind it. The dashboard
// just posts the raw text of the field; formatting an array back into
// bracket form for display is a one-liner it does itself.

/** Settings whose values are phrase lists, and so accept bracket text. */
export const PHRASE_LIST_KEYS = new Set([
  'voice_wake_words',
  'voice_cancel_words',
  'voice_stop_speaking_words',
  'voice_stop_listening_words',
  'voice_leave_words',
]);

/** Placeholder in bracket phrases that expands to the bot's name at runtime.
 * Write [hey {ai}] in the dashboard — it matches "hey helena" when the bot is
 * Helena, and still works after a rename without re-saving wake words. */
export const AI_NAME_PLACEHOLDER = '{ai}';

/** Internal marker that survives normalizePhrase while {ai} is parsed. */
const AI_MARKER = '00botname00';

function preserveAiPlaceholder(text) {
  return String(text).replace(/\{ai\}/gi, AI_MARKER);
}

function restoreAiPlaceholder(text) {
  return String(text).replaceAll(AI_MARKER, AI_NAME_PLACEHOLDER);
}

/**
 * Expand {ai} in stored phrase templates to the bot's current name, then
 * normalize for matching. Safe to call on already-expanded lists (no {ai} left).
 */
export function expandPhraseTemplates(phrases, botName) {
  const name = normalizePhrase(botName);
  const seen = new Set();
  const out = [];
  for (const phrase of phrases || []) {
    const raw = String(phrase);
    // A name that normalizes away entirely — an all-emoji nickname, say —
    // would turn "[hey {ai}]" into the bare phrase "hey". Matching is
    // SUBSTRING based, so that wake word fires on "they said it was fine",
    // and the bot interjects on ordinary conversation. Drop the template
    // instead; voicePhrases() falls back to the shipped defaults if that
    // empties the list.
    if (!name && /\{ai\}/i.test(raw)) continue;
    const expanded = normalizePhrase(raw.replace(/\{ai\}/gi, name));
    if (!expanded || seen.has(expanded)) continue;
    seen.add(expanded);
    out.push(expanded);
  }
  return out;
}

/**
 * Normalize a phrase for fuzzy matching: lowercased, punctuation and other
 * non-alphanumeric characters collapsed to a single space.
 *
 * Applied to BOTH sides of a comparison — the live transcript and the stored
 * phrase. Doing it to only the transcript (which is what voice.js used to do)
 * is what made a phrase containing punctuation impossible to match: the
 * transcript "Max, are you there?" normalized to "max are you there", which
 * never contains the literal needle "max, are you there".
 */
export function normalizePhrase(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Turn dashboard input into a clean phrase list.
 *
 * Accepts, in order of preference:
 *   - an array (the API's own format, and what is already in the database)
 *   - bracket text: "[hey max] [hey andrew]"
 *   - legacy comma text: "hey max, hey andrew"
 *
 * The comma fallback is deliberate. Existing installs have comma habits and
 * saved values, and a parser that returned nothing for the old format would
 * silently wipe someone's wake words the first time they pressed Save.
 *
 * Phrases are normalized, blanks dropped, duplicates removed (first wins).
 */
export function parsePhraseList(input) {
  if (input == null) return [];
  let raw;

  if (Array.isArray(input)) {
    raw = input;
  } else {
    const text = String(input);
    const groups = [...text.matchAll(/\[([^\]]*)\]/g)].map((m) => m[1]);
    if (groups.length) {
      // Bracket form. Text outside the brackets is ignored — with complete
      // groups present, stray text is far more likely to be a stray keystroke
      // than a phrase someone meant to add.
      raw = groups;
    } else {
      // No complete pair — either the old comma format, or a half-typed
      // "[hey max". Strip any stray brackets and fall back to commas rather
      // than returning nothing and erasing the list.
      raw = text.replace(/[[\]]/g, ' ').split(',');
    }
  }

  const seen = new Set();
  const out = [];
  for (const phrase of raw) {
    const normalized = restoreAiPlaceholder(
      normalizePhrase(preserveAiPlaceholder(phrase)),
    );
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

/** Render a phrase list back into the bracket form the dashboard shows. */
export function formatPhraseList(list) {
  return (Array.isArray(list) ? list : [])
    .map((phrase) => `[${phrase}]`)
    .join(' ');
}
