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

// The agreed Voice Trigger phrase list (CONTEXT.md, confirmed with the
// user). No-topic phrases already carry their own referent ("that"/
// "this"), so they never have a topic of their own to extract; topic-
// taking phrases are followed by whatever topic text comes after them,
// if any. Checked as a no-topic-first whole-string match (see
// detectResearchTrigger below) so a longer no-topic idiom that happens to
// contain a topic-taking phrase's prefix (e.g. "let's search for that"
// containing both "search for that" and the start of "let's search for")
// is always resolved as the no-topic idiom, never as a topic-taking match
// with a literal "that" captured as the "topic".
const NO_TOPIC_PHRASES = [
  "let'?s look that up",
  "let'?s look this up",
  'look that up',
  'look this up',
  "let'?s google that",
  "let'?s google this",
  'google that',
  'google this',
  "let'?s search that",
  'search for that'
]
// "can you/we look up" are functionally subsumed by the bare "look up"
// entry below (whichever phrase starts earliest in the utterance wins —
// see detectResearchTrigger's doc comment), but are still listed
// explicitly since they're part of the agreed phrase list in their own
// right, not merely incidental matches of a shorter phrase.
const TOPIC_PHRASES = [
  "let'?s look up",
  'can you look up',
  'can we look up',
  'look up',
  "let'?s search for",
  "what'?s the definition of",
  'what is the definition of',
  'define'
]

const NO_TOPIC_PHRASE = new RegExp(`\\b(?:${NO_TOPIC_PHRASES.join('|')})\\b`, 'i')
const TOPIC_PHRASE = new RegExp(`\\b(?:${TOPIC_PHRASES.join('|')})\\b\\s*(.*)$`, 'i')

export function detectResearchTrigger(utterance) {
  const text = String(utterance ?? '')

  if (NO_TOPIC_PHRASE.test(text)) return { topic: null }

  const match = TOPIC_PHRASE.exec(text)
  if (!match) return null
  const topic = match[1].trim()
  return { topic: topic || null }
}
