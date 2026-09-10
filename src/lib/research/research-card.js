/**
 * Research Card — the field-based shape the model returns (see
 * `.scratch/research-assistant/findings.md`'s system prompt: PROVEN IN
 * TRANSCRIPT, UBIQUITOUS KNOWLEDGE, OUTPUT TYPE, MAIN TAKEAWAY — CONTEXT
 * SUMMARY was dropped as a redundant field that just restated part of MAIN
 * TAKEAWAY for an extra output-token cost every call). There is
 * deliberately no SOURCES field on the card — the
 * model's own self-reported sources duplicated (and often contradicted)
 * `citations`, the ground-truth list of pages OpenRouter's web-search
 * plugin actually fetched (see research-assistant.js's `citations`,
 * carried separately on the wire and rendered by ResearchPanel.svelte
 * under the card, not baked into it). One list, backed by the tool call
 * that actually happened, beats two.
 *
 * Two different serializations flow through `parseResearchCard`, and it has
 * to handle both: (1) the model's own raw response is plain labeled text,
 * not JSON — it's asked for "exactly these fields, in this order, nothing
 * else" — parsed server-side in research-assistant.js by splitting on those
 * labels; (2) `serializeResearchCard`'s JSON string is what actually goes
 * out over the wire as `research_resolve`'s `answer`, and the panel calls
 * `parseResearchCard` again on *that* to render it. Skipping the JSON
 * branch here means the client-side call falls through to the leftover-
 * prose fallback and renders the raw `{"provenInTranscript":...}` blob
 * instead of the card — try JSON first, always.
 *
 * ADR-0008/ticket 07: the fixed Definition/Facts/Answer Turn Actions, their
 * MODE_RULES, and the app-side suppression guards that policed them
 * (shouldSuppress/matchesMode) are retired — every lookup is now a
 * user-authored Custom Prompt, freeform like Ask always was. There is no
 * remaining non-freeform card shape, so this module no longer distinguishes
 * one: every mode in MODES is freeform.
 */
export const MODES = ['custom', 'ask']

const FIELD_LABELS = [
  ['provenInTranscript', 'PROVEN IN TRANSCRIPT'],
  ['ubiquitousKnowledge', 'UBIQUITOUS KNOWLEDGE'],
  ['outputType', 'OUTPUT TYPE'],
  ['mainTakeaway', 'MAIN TAKEAWAY']
]

// The prompt tells the model never to cite inline (citations are reported
// separately, from the web-search plugin's own annotations — see
// research-assistant.js), but that's a request, not a guarantee: models
// keep dropping a markdown link or bare URL into mainTakeaway anyway. Strip
// it app-side rather than trust compliance.
function stripInlineCitations(value) {
  // Keep line breaks (every mode is freeform now). Collapse only
  // spaces/tabs on a line so a markdown-link strip doesn't leave ragged
  // indent.
  return String(value || '')
    .replace(/\[[^\]]*\]\((?:https?:\/\/|www\.)[^)]+\)/gi, '') // [label](url) citation, whole thing
    .replace(/\(?\bhttps?:\/\/\S+\)?/gi, '') // bare URL, with an optional wrapping paren
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *([.,;:!?])/g, '$1')
    .replace(/[^\S\n]+\n/g, '\n')
    .replace(/\n[^\S\n]+/g, '\n')
    .trim()
}

function toScore(value) {
  const n = Number(String(value ?? '').trim())
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(100, Math.round(n)))
}

/**
 * Splits the model's labeled plain-text response into raw field strings.
 * A field's value is everything up to the next recognized label (fields
 * can wrap multiple lines even though the prompt asks for one paragraph
 * each — small models don't always hold to that).
 */
function splitFields(text) {
  const labelPattern = FIELD_LABELS.map(([, label]) => label).join('|')
  const re = new RegExp(`^(${labelPattern})\\s*:\\s*`, 'i')
  const lines = text.split(/\r?\n/)
  const raw = {}
  let currentKey = null

  for (const line of lines) {
    const match = line.match(re)
    if (match) {
      const label = match[1].toUpperCase()
      const key = FIELD_LABELS.find(([, l]) => l === label)[0]
      currentKey = key
      raw[key] = line.slice(match[0].length).trim()
    } else if (currentKey) {
      raw[currentKey] = `${raw[currentKey]} ${line.trim()}`.trim()
    }
  }
  return raw
}

/** Returns a sanitized card for a non-empty answer string; null for
 *  empty/missing (the model was told to output nothing when no claim
 *  survives selection, or `serializeResearchCard(null)`'s literal "null").
 *  Tries JSON first (the wire format `serializeResearchCard` produces —
 *  see the module doc comment), then falls back to splitting the model's
 *  own labeled plain text. Leftover prose with no recognized labels (e.g.
 *  a mocked answer in a test, or a model that ignored the field format) is
 *  still treated as a card — its whole text becomes MAIN TAKEAWAY, same
 *  discipline the old skim-card parser used for unlabeled text. */
export function parseResearchCard(raw) {
  if (raw == null) return null
  if (typeof raw === 'object') return normalizeEmptyCard(sanitizeResearchCard(raw))
  const text = String(raw).trim()
  if (!text) return null

  const parsedJson = tryParseJson(text)
  if (parsedJson === null) return null // serializeResearchCard(null) round-trips to no card
  if (parsedJson) return normalizeEmptyCard(sanitizeResearchCard(parsedJson))

  const fields = splitFields(text)
  if (!fields.mainTakeaway) {
    return sanitizeResearchCard({ mainTakeaway: text })
  }
  return sanitizeResearchCard(fields)
}

// A forced-JSON reply can't literally be empty the way old plain-text
// "output nothing" could — the schema always returns a full object. The
// model signals "nothing survives the mode rule" by leaving mainTakeaway
// blank; treat that the same as no card at all.
function normalizeEmptyCard(card) {
  if (!card.mainTakeaway) return null
  return card
}

// Returns the parsed value for well-formed JSON (including the literal
// `null`), or `undefined` when `text` isn't JSON at all — kept distinct
// from `null` so the caller can tell "this was JSON for no card" apart
// from "this was never JSON, try the plain-text format instead".
function tryParseJson(text) {
  if (!text.startsWith('{') && text !== 'null') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export function sanitizeResearchCard(raw) {
  return {
    provenInTranscript: toScore(raw?.provenInTranscript),
    ubiquitousKnowledge: toScore(raw?.ubiquitousKnowledge),
    outputType: MODES.includes(raw?.outputType) ? raw.outputType : null,
    mainTakeaway: stripInlineCitations(raw?.mainTakeaway)
  }
}

export function serializeResearchCard(card) {
  return JSON.stringify(card ? sanitizeResearchCard(card) : null)
}
