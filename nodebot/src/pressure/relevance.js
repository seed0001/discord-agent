// Relevance evaluation boundary. Ported from pressure/relevance.py.
//
// In production an LLM classifies whether a drafted contribution is relevant
// to the live topic and scores it 0..1; the engine only consumes the score.
// heuristicRelevance is the deterministic stand-in used by tests and the
// simulator — token overlap, no model calls.

export function heuristicRelevance(proposalTopic, currentTopic) {
  if (!currentTopic) return 0.5;
  if (proposalTopic === currentTopic) return 1.0;
  const tokens = (text) => new Set([
    ...text.toLowerCase().split('-'),
    ...text.toLowerCase().split(/\s+/),
  ].filter(Boolean));
  const a = tokens(proposalTopic);
  const b = tokens(currentTopic);
  if (!a.size || !b.size) return 0.0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  const union = new Set([...a, ...b]).size;
  return shared / union;
}
