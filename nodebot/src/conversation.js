// The whole point of this rebuild: ONE shared timeline per guild, not a
// separate buffer per modality. The Python bot's hybrid split meant text
// chat history (ai.py's self.history) and voice transcripts (voice.py's
// self.transcripts) were two different in-memory structures the model
// never saw both of at once for immediate context — durable/working
// memory eventually caught up, but not right away, and not for anything
// short-term. Here there's exactly one buffer per guild; text and voice
// both write into it and both read from it, so something said in #general
// a second ago is already there the instant voice asks about it, no gap.
//
// In-memory only for now (mirrors the Python bot's short-term history,
// not its persistent durable/profile/manuscript/knowledge-base memory —
// that's a later layer, ported once this is proven out).
const MAX_TURNS = 40;

const turns = new Map(); // guildId -> array of {source, channel, speaker, text, ts}

function bufferFor(guildId) {
  if (!turns.has(guildId)) turns.set(guildId, []);
  return turns.get(guildId);
}

/**
 * @param {string} guildId
 * @param {{source: 'text'|'voice', channel: string, speaker: string, text: string}} entry
 */
export function recordTurn(guildId, entry) {
  const text = (entry.text || '').trim();
  if (!text) return;
  const buf = bufferFor(guildId);
  buf.push({ ...entry, text, ts: Date.now() });
  if (buf.length > MAX_TURNS) buf.shift();
}

export function getRecentTurns(guildId, limit = MAX_TURNS) {
  return bufferFor(guildId).slice(-limit);
}

function location(entry) {
  if (!entry.channel) return entry.source;
  return entry.source === 'voice' ? `voice/${entry.channel}` : `#${entry.channel}`;
}

/** Recent turns formatted for a system/context prompt, tagged with where
 * each one happened — same convention as the Python bot's memory.py, which
 * is what lets the model answer "did you see what I posted in #general"
 * regardless of which channel or modality it's being asked from. */
export function formatForPrompt(guildId, limit = MAX_TURNS) {
  return getRecentTurns(guildId, limit)
    .map((t) => `[${location(t)}] ${t.speaker}: ${t.text}`)
    .join('\n');
}
