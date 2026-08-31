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

// The five Quick Action buttons (CONTEXT.md's Quick Action entry), each
// mapped to the instruction it turns into against the active tab's full
// text.
const QUICK_ACTION_INSTRUCTIONS = {
  define: 'Define the key term(s) in the following text.',
  keyFacts: 'List the key facts in the following text.',
  factCheck: 'Fact-check the claims in the following text.',
  findExamples: 'Find real-world examples relevant to the following text.',
  analyze: 'Analyze the following text.'
}

// Turns a small, intent-based `request` (never a raw OpenAI-style
// `messages` array handed in from outside) into the actual prompt text
// for each of the two request kinds — see CONTEXT.md's Voice Trigger /
// Quick Action entries. Kept internal: callers never see prompt text.
function buildMessages(request) {
  if (request.kind === 'quickAction') {
    const instruction = QUICK_ACTION_INSTRUCTIONS[request.actionId]
    if (!instruction) {
      throw new ResearchAssistantError('INVALID_REQUEST', `Unknown Quick Action id: ${request.actionId}`)
    }
    return [
      {
        role: 'system',
        content:
          'You are the Research Assistant for a live podcast recording. Answer briefly and factually, grounded in web search results.'
      },
      { role: 'user', content: `${instruction}\n\n${request.text}` }
    ]
  }

  if (request.kind === 'voice') {
    const { query, context, notes } = request
    const topicLine = query
      ? `The participant asked to look up: "${query}".`
      : `The participant asked to look something up but did not name a topic — infer it from the recent conversation below.`
    return [
      {
        role: 'system',
        content:
          'You are the Research Assistant for a live podcast recording. Answer briefly and factually, grounded in web search results.'
      },
      {
        role: 'user',
        content: [
          topicLine,
          context ? `Recent conversation:\n${context}` : '',
          notes ? `Notes for grounding:\n${notes}` : ''
        ]
          .filter(Boolean)
          .join('\n\n')
      }
    ]
  }

  throw new ResearchAssistantError('INVALID_REQUEST', `Unknown request kind: ${request?.kind}`)
}

function buildRequestBody(request) {
  return {
    model: env.OPENROUTER_MODEL || DEFAULT_MODEL,
    messages: buildMessages(request),
    plugins: [{ id: 'web' }]
  }
}

export async function askResearchAssistant(request, { fetchImpl = fetch } = {}) {
  const apiKey = env.OPENROUTER_API_KEY
  if (!apiKey) {
    throw new ResearchAssistantError('NOT_CONFIGURED', 'OPENROUTER_API_KEY is not configured')
  }

  const body = JSON.stringify(buildRequestBody(request)) // let INVALID_REQUEST surface before any network attempt

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
  const answer = message?.content?.trim()
  if (!answer) {
    throw new ResearchAssistantError('EMPTY_ANSWER', 'OpenRouter returned no usable answer')
  }

  const citations = (message.annotations ?? [])
    .filter((a) => a.type === 'url_citation')
    .map((a) => ({ url: a.url_citation.url, title: a.url_citation.title }))

  return { answer, citations }
}
