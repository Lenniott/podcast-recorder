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
 * This module also owns the two app-side guards the findings doc calls out
 * as not safe to leave to the prompt alone: score-threshold suppression
 * (`shouldSuppress`) and mode-match verification (`matchesMode`). Both are
 * things the caller can check deterministically, so neither is left to the
 * model to police itself.
 */
export const SUPPRESS_THRESHOLD = 80 // tunable client-side constant, not baked into the prompt

// Shared-system-prompt rules only (see research-assistant.js's
// buildSystemPrompt): Turn Actions. Typed Ask and Custom are freeform —
// the Ask box / Research Prompt *is* the request, so they are not here.
// `MODES` is the card outputType allowlist: Turn Action keys plus those two.
export const MODE_RULES = {
  definition:
    'Explain an obscure word, name, or reference in the FOCUS TURN, including a plausible mishear if the transcript likely garbled it. include how to pronounce it phonetically if it is not a common word. If nothing needs defining, output nothing.',
  facts:
    'Surface general background about what the FOCUS TURN is talking about. Do not say whether the speaker was right. Grounding is only for references — never the subject.',
  answer:
    'Reply to a question asked in the FOCUS TURN itself. If that Turn is not a question, output nothing rather than answering a different, easier question.'
}

export const TURN_ACTION_IDS = ['definition', 'facts', 'answer']
export const FREEFORM_MODES = ['custom', 'ask']
export const MODES = [...Object.keys(MODE_RULES), ...FREEFORM_MODES]

export function isFreeformMode(mode) {
  return FREEFORM_MODES.includes(mode)
}

const MAX_TAKEAWAY_WORDS = 35

const FIELD_LABELS = [
  ['provenInTranscript', 'PROVEN IN TRANSCRIPT'],
  ['ubiquitousKnowledge', 'UBIQUITOUS KNOWLEDGE'],
  ['outputType', 'OUTPUT TYPE'],
  ['mainTakeaway', 'MAIN TAKEAWAY']
]

function clipWords(value, maxWords) {
  const words = String(value || '').trim().split(/\s+/).filter(Boolean)
  return words.slice(0, maxWords).join(' ')
}

// The prompt tells the model never to cite inline (citations are reported
// separately, from the web-search plugin's own annotations — see
// research-assistant.js), but that's a request, not a guarantee: models
// keep dropping a markdown link or bare URL into mainTakeaway anyway. Strip
// it app-side rather than trust compliance, same reasoning as
// shouldSuppress/matchesMode below.
function stripInlineCitations(value, { preserveNewlines = false } = {}) {
  let text = String(value || '')
    .replace(/\[[^\]]*\]\((?:https?:\/\/|www\.)[^)]+\)/gi, '') // [label](url) citation, whole thing
    .replace(/\(?\bhttps?:\/\/\S+\)?/gi, '') // bare URL, with an optional wrapping paren
  if (preserveNewlines) {
    // Keep line breaks (Custom / Ask freeform). Collapse only spaces/tabs
    // on a line so a markdown-link strip doesn't leave ragged indent.
    return text
      .replace(/[^\S\n]+/g, ' ')
      .replace(/ *([.,;:!?])/g, '$1')
      .replace(/[^\S\n]+\n/g, '\n')
      .replace(/\n[^\S\n]+/g, '\n')
      .trim()
  }
  return text
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
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
    mainTakeaway: isFreeformMode(raw?.outputType)
      ? stripInlineCitations(raw?.mainTakeaway, { preserveNewlines: true })
      : clipWords(stripInlineCitations(raw?.mainTakeaway), MAX_TAKEAWAY_WORDS)
  }
}

export function serializeResearchCard(card) {
  return JSON.stringify(card ? sanitizeResearchCard(card) : null)
}

/** Score-threshold suppression (findings doc, "App-side logic required" #1)
 *  — the model always returns full output; the app decides whether to
 *  render it. Kept as a plain function of a tunable threshold, not baked
 *  into the prompt, so it can be adjusted without a prompt change. */
export function shouldSuppress(card, mode, threshold = SUPPRESS_THRESHOLD) {
  if (!card) return true
  if ((card.provenInTranscript ?? 0) > threshold) return true
  // Ubiquitous knowledge is only a hide-rule for Definition — Facts is
  // often common background, and Ask/Answer/Custom are explicit requests.
  if (mode === 'definition' && (card.ubiquitousKnowledge ?? 0) > threshold) return true
  return false
}

/** Mode-match verification (findings doc, "App-side logic required" #2) —
 *  the model can silently swap OUTPUT TYPE to an easier mode than the one
 *  requested (Bug 1). The prompt now instructs against this but is
 *  best-effort, not guaranteed, so the app checks directly rather than
 *  trusting the model to police itself. */
export function matchesMode(card, requestedMode) {
  return !!card && card.outputType === requestedMode
}
