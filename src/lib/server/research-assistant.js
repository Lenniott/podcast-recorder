/**
 * Research Assistant Client — the Research Assistant's one deep module
 * (`.scratch/research-assistant/issues/02-research-endpoint.md`). A single
 * public entry point, `askResearchAssistant(request)`, hides everything
 * about *how* a lookup request becomes an answer: which OpenRouter model
 * is called (env-configured, defaulting to a cheap model), how each
 * request kind becomes actual prompt text, that the web-search plugin is
 * always enabled (grounding decision — answers cite real search results),
 * retry/timeout handling, and how the raw OpenRouter response is parsed
 * into `{ answer, citations }`.
 *
 * Deliberately unrelated to the Room State Store (ticket 00) or to
 * `./research-trigger.js`'s trigger detection — this module owns *how a
 * lookup request becomes an answer*, nothing about where a room's content
 * lives or whether to call this module at all.
 *
 * The OpenRouter API key is read only from `OPENROUTER_API_KEY` (a
 * server-side env var, see `.env.example`) and never appears in any value
 * this module returns or throws.
 */
import { env } from '$env/dynamic/private'
import { matchesMode, MODE_RULES, MODES, parseResearchCard, serializeResearchCard, shouldSuppress } from '../research-card.js'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const DEFAULT_MODEL = 'openai/gpt-4o-mini' // cheap, per the ticket's "default a cheap model"
const REQUEST_TIMEOUT_MS = 20_000

export class ResearchAssistantError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ResearchAssistantError'
    this.code = code
  }
}

// The shared system prompt for every mode — `.scratch/research-
// assistant/findings.md`. One schema, one suppression logic; the button
// (or Quick Action / voice ask) only picks MODE, so a future auto-trigger
// model only has to pick a mode, not learn a separate format per button.
// The mode registry (research-card.js's MODE_RULES) is open-ended — adding
// a new Quick Action means adding one selection-rule sentence there, not
// touching this prompt. `{timestamp}`/`{mode}` are substituted below —
// never sent as literal template syntax (see the findings doc's Bug 2).
function buildSystemPrompt(pressTimeIso, mode) {
  const otherModes = MODES.filter((m) => m !== mode)
  return `You are a research assistant. You receive: (1) the last 10 minutes of transcript as your PRIMARY FOCUS, and (2) earlier transcript as GROUNDING ONLY — use it to resolve references but never as the subject of your answer unless the focus window explicitly returns to it.

PRESS_TIME: ${pressTimeIso}
FOCUS WINDOW: transcript from PRESS_TIME minus 10 min to PRESS_TIME
MODE: ${mode}

Before answering, identify every discrete factual claim in the focus window relevant to the mode. From what remains, select only the single most salient checkable claim (the most recent, or the one most load-bearing to what's being discussed).

Mode-specific selection rule for ${mode}: ${MODE_RULES[mode]}

Output exactly these fields, in this order, nothing else:

PROVEN IN TRANSCRIPT: 0-100. How directly this claim has already been confirmed, corrected, or settled earlier in the transcript (grounding included). 0 = never touched on, 100 = already fully resolved on the record.
UBIQUITOUS KNOWLEDGE: 0-100. How well a reasonably informed adult would already know this. 0 = genuinely obscure, 100 = common knowledge.
OUTPUT TYPE: write "${mode}" — the mode name you were given above. Never substitute a different mode (e.g. ${otherModes[0]}), and never leave this as a placeholder — write the actual word.
CONTEXT SUMMARY: max 12 words. The specific claim selected, not the whole sentence.
MAIN TAKEAWAY: max 35 words. One paragraph. Stated as fact. No hedging.
SOURCES: names only, max 2, from: Wikipedia, Reddit. Omit line if unused.

Hard rules:
- No preamble, no restating the question, no closing remarks.
- One paragraph per field.
- If no claim survives selection, output nothing.`
}

// Turns a small, intent-based `request` (never a raw OpenAI-style
// `messages` array handed in from outside) into the actual prompt text —
// see CONTEXT.md's Voice Trigger / Quick Action entries. Kept internal:
// callers never see prompt text. Every request kind resolves to one of
// MODES; `askResearchAssistant` needs the resolved mode later for
// mode-match verification, so this returns it alongside the messages
// rather than burying it back inside `request`.
function buildMessages(request, pressTime = new Date()) {
  const pressTimeIso = pressTime.toISOString()

  if (request.kind === 'quickAction') {
    if (!MODES.includes(request.actionId)) {
      throw new ResearchAssistantError('INVALID_REQUEST', `Unknown Quick Action id: ${request.actionId}`)
    }
    const mode = request.actionId
    return {
      mode,
      messages: [
        { role: 'system', content: buildSystemPrompt(pressTimeIso, mode) },
        { role: 'user', content: `FOCUS WINDOW:\n${request.text}` }
      ]
    }
  }

  if (request.kind === 'voice') {
    const { query, context, notes } = request
    const mode = 'research' // a typed question or "research recent conversation" is always the research mode's own shape
    return {
      mode,
      messages: [
        { role: 'system', content: buildSystemPrompt(pressTimeIso, mode) },
        {
          role: 'user',
          content: [
            query ? `Question asked: "${query}"` : '',
            context ? `FOCUS WINDOW:\n${context}` : '',
            notes ? `GROUNDING:\n${notes}` : ''
          ]
            .filter(Boolean)
            .join('\n\n')
        }
      ]
    }
  }

  throw new ResearchAssistantError('INVALID_REQUEST', `Unknown request kind: ${request?.kind}`)
}

function buildRequestBody(request, pressTime) {
  const { mode, messages } = buildMessages(request, pressTime)
  return {
    mode,
    body: {
      model: env.OPENROUTER_MODEL || DEFAULT_MODEL,
      messages,
      plugins: [{ id: 'web' }]
    }
  }
}

export async function askResearchAssistant(request, { fetchImpl = fetch, pressTime = new Date() } = {}) {
  const apiKey = env.OPENROUTER_API_KEY
  if (!apiKey) {
    throw new ResearchAssistantError('NOT_CONFIGURED', 'OPENROUTER_API_KEY is not configured')
  }

  const { mode, body: requestBody } = buildRequestBody(request, pressTime) // let INVALID_REQUEST surface before any network attempt
  const body = JSON.stringify(requestBody)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  let res
  try {
    res = await fetchImpl(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body,
      signal: controller.signal
    })
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw new ResearchAssistantError('TIMEOUT', 'OpenRouter request timed out')
    }
    // Any other network-level failure is still "the call to the upstream
    // API didn't work" — the same bucket a non-2xx status falls into
    // below, never leaking `e` (which could echo the request) upward.
    throw new ResearchAssistantError('UPSTREAM_ERROR', 'Failed to reach OpenRouter')
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    // Deliberately not including the response body or the request we
    // sent in this message — never a channel the API key could leak
    // through, even indirectly.
    throw new ResearchAssistantError('UPSTREAM_ERROR', `OpenRouter responded with status ${res.status}`)
  }

  const data = await res.json()
  const message = data?.choices?.[0]?.message
  const raw = message?.content?.trim()
  if (!raw) {
    throw new ResearchAssistantError('EMPTY_ANSWER', 'OpenRouter returned no usable answer')
  }

  const citations = (message.annotations ?? [])
    .filter((a) => a.type === 'url_citation')
    .map((a) => ({ url: a.url_citation.url, title: a.url_citation.title }))

  const card = parseResearchCard(raw)

  // Two app-side guards the findings doc calls out as unsafe to leave to
  // the prompt alone (both are things this caller can verify directly,
  // rather than trusting the model to police itself):
  //   1. Score-threshold suppression — already-settled or common-knowledge
  //      claims are never rendered, regardless of what the model returned.
  //   2. Mode-match verification — a response claiming a different
  //      OUTPUT TYPE than the one requested (Bug 1: mode substitution under
  //      pressure) is discarded rather than rendered under the wrong mode.
  const usable = card && !shouldSuppress(card) && matchesMode(card, mode)

  return { answer: serializeResearchCard(usable ? card : null), citations: usable ? citations : [] }
}
