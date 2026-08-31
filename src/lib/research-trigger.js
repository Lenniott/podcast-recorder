/**
 * Voice Trigger detection (CONTEXT.md's "Voice Trigger" entry) — a pure
 * function with no knowledge of the Research Assistant Client, HTTP, or
 * AI models. It answers exactly one question: does this one finalized
 * utterance contain a Voice Trigger phrase, and if so, what topic (if
 * any) follows it?
 *
 * Deliberately separate from `$lib/server/research-assistant.js` — see
 * `.scratch/research-assistant/issues/02-research-endpoint.md`: this
 * module doesn't call that one, and doesn't know it exists. Ticket 06's
 * voice wiring is what decides, using this function's result, whether to
 * call the Research Assistant Client at all.
 */

// The agreed Voice Trigger phrase list (CONTEXT.md). "let's look that up"
// is a fixed idiom on its own — "that" already refers to something, so it
// never carries a topic of its own; "let's look up" and "define" are
// followed by whatever topic text comes after them, if any.
const NO_TOPIC_PHRASE = /\blet'?s look that up\b/i
const TOPIC_PHRASE = /\b(?:let'?s look up|define)\b\s*(.*)$/i

export function detectResearchTrigger(utterance) {
  const text = String(utterance ?? '')

  if (NO_TOPIC_PHRASE.test(text)) return { topic: null }

  const match = TOPIC_PHRASE.exec(text)
  if (!match) return null
  const topic = match[1].trim()
  return { topic: topic || null }
}
