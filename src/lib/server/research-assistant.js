/**
 * Research Assistant Client — one entry point, `askResearchAssistant(request)`,
 * turns a lookup into `{ answer, citations }`. Callers never see prompt text.
 */
import { env } from '$env/dynamic/private'
import { isFreeformMode, matchesMode, MODE_RULES, parseResearchCard, serializeResearchCard, shouldSuppress } from '../research/research-card.js'
import { appendResearchEvalLog } from './research-eval-log.js'
import { recordResearchUsage } from './db.js'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const DEFAULT_MODEL = 'openai/gpt-4o-mini'
const REQUEST_TIMEOUT_MS = 20_000
const CUSTOM_REQUEST_TIMEOUT_MS = 45_000

export class ResearchAssistantError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ResearchAssistantError'
    this.code = code
  }
}

function buildSystemPrompt(pressTimeIso, mode) {
  return `You are a research assistant. When you receive a FOCUS TURN, that Turn is the subject of your answer. GROUNDING is nearby Turns for resolving references only — never answer about Grounding instead of the Focus Turn.

PRESS_TIME: ${pressTimeIso}
MODE: ${mode}

Mode-specific rule for ${mode}: ${MODE_RULES[mode]}

Reply with the structured fields the response schema asks for:

provenInTranscript: 0-100. How directly this has already been confirmed, corrected, or settled in Grounding. 0 = never touched on, 100 = already fully resolved on the record.
ubiquitousKnowledge: 0-100. How well a reasonably informed adult would already know this. 0 = genuinely obscure, 100 = common knowledge.
outputType: always "${mode}" — the mode you were given above.
mainTakeaway: max 35 words. One paragraph. Stated as fact. No hedging.

Hard rules:
- No preamble, no restating the question, no closing remarks.
- Never cite a source inline — no URLs, no markdown links, no "according to X". Sources you used are reported separately and automatically; naming or linking one yourself is redundant and against the word limit.
- If nothing survives the mode rule, leave mainTakeaway an empty string and the scores 0 — that combination means "nothing to report".`
}

// Placeholder substitution (see CONTEXT.md) — the one place `{current_tab}`/
// `{transcript}` get resolved, so every free-text field that accepts them
// (the Research Prompt, an Ask question) goes through this same rule
// rather than each caller splicing strings its own way. A placeholder with
// no value supplied (e.g. `{transcript}` before any transcript exists)
// resolves to '' — silently, not an error: the host's own prompt text is
// what decides whether that's worth noting.
const PLACEHOLDERS = { current_tab: 'currentTab', transcript: 'transcript' }

export function applyPlaceholders(template, values = {}) {
  return String(template || '').replace(/\{(\w+)\}/g, (match, name) => {
    const key = PLACEHOLDERS[name]
    return key ? String(values[key] ?? '') : match
  })
}

function buildMessages(request, pressTime = new Date()) {
  const pressTimeIso = pressTime.toISOString()

  if (request.kind === 'turnAction') {
    if (!['definition', 'facts', 'answer'].includes(request.actionId)) {
      throw new ResearchAssistantError('INVALID_REQUEST', `Unknown Turn Action id: ${request.actionId}`)
    }
    const mode = request.actionId
    return {
      mode,
      messages: [
        { role: 'system', content: buildSystemPrompt(pressTimeIso, mode) },
        {
          role: 'user',
          content: [`FOCUS TURN:\n${request.focus}`, request.grounding ? `GROUNDING:\n${request.grounding}` : '']
            .filter(Boolean)
            .join('\n\n')
        }
      ]
    }
  }

  if (request.kind === 'custom') {
    // The Research Prompt (see CONTEXT.md) is the whole request — no
    // hardcoded stage structure wraps it any more (see ADR-0006).
    // Whatever `{current_tab}`/`{transcript}` the host's own prompt text
    // references is resolved here, the one seam every Placeholder goes
    // through (applyPlaceholders above).
    const template = String(request.instruction || '').trim()
    if (!template) {
      throw new ResearchAssistantError('INVALID_REQUEST', 'Research Prompt is not configured')
    }
    const instruction = applyPlaceholders(template, {
      currentTab: request.text,
      transcript: request.transcript
    })
    const mode = 'custom'
    return {
      mode,
      messages: [{ role: 'user', content: instruction }]
    }
  }

  if (request.kind === 'voice') {
    // Typed Ask is freeform like Custom: the box text *is* the request.
    // No shared system prompt, no MODE_RULES.ask. Placeholders in the
    // typed text still resolve here. context/notes stay optional extras
    // (eval harness / leftover voice-shaped callers).
    const query = applyPlaceholders(request.query, { currentTab: request.currentTab, transcript: request.transcript })
    const userContent = [
      query ? String(query).trim() : '',
      request.context ? `FOCUS TURN:\n${request.context}` : '',
      request.notes ? `GROUNDING:\n${request.notes}` : ''
    ]
      .filter(Boolean)
      .join('\n\n')
    if (!userContent.trim()) {
      throw new ResearchAssistantError('INVALID_REQUEST', 'Ask question is empty')
    }
    return {
      mode: 'ask',
      messages: [{ role: 'user', content: userContent }]
    }
  }

  throw new ResearchAssistantError('INVALID_REQUEST', `Unknown request kind: ${request?.kind}`)
}

// Structured-output schema for Turn Actions only — Custom and typed Ask
// send freeform text (see askResearchAssistant's `isFreeformMode`
// branch), not parsed field-by-field, so they aren't forced through this.
// Forcing the shape here (rather than just asking for it in the prompt
// text) is what stops the model from e.g. echoing a placeholder/wrong
// value for outputType. There is no `sources` field: the card doesn't
// self-report citations — `citations` (below, from the web-search plugin's
// own annotations) is the ground-truth list of what was actually fetched,
// and asking the model to also name sources just produced a second,
// looser list that duplicated or contradicted the first.
function researchCardSchema(mode) {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'research_card',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          provenInTranscript: { type: 'integer', minimum: 0, maximum: 100 },
          ubiquitousKnowledge: { type: 'integer', minimum: 0, maximum: 100 },
          outputType: { type: 'string', enum: [mode] },
          mainTakeaway: { type: 'string' }
        },
        required: ['provenInTranscript', 'ubiquitousKnowledge', 'outputType', 'mainTakeaway'],
        additionalProperties: false
      }
    }
  }
}

function buildRequestBody(request, pressTime) {
  const { mode, messages } = buildMessages(request, pressTime)
  return {
    mode,
    messages,
    body: {
      model: env.OPENROUTER_MODEL || DEFAULT_MODEL,
      messages,
      plugins: [{ id: 'web' }],
      // Asks OpenRouter to report actual cost on `usage.cost` — see
      // ADR-0007 — so the Usage Dashboard doesn't need to price each model
      // itself from a maintained table.
      usage: { include: true },
      ...(isFreeformMode(mode) ? {} : { response_format: researchCardSchema(mode) })
    }
  }
}

function suppressReason(card, mode) {
  if (!card) return 'empty-or-unparseable'
  if (!matchesMode(card, mode)) return 'mode-mismatch'
  if (shouldSuppress(card, mode)) {
    if ((card.provenInTranscript ?? 0) > 80) return 'proven-in-transcript'
    if (mode === 'definition') return 'ubiquitous-knowledge'
    return 'suppressed'
  }
  return null
}

export async function askResearchAssistant(request, { fetchImpl = fetch, pressTime = new Date(), roomSlug = null } = {}) {
  const apiKey = env.OPENROUTER_API_KEY
  if (!apiKey) {
    throw new ResearchAssistantError('NOT_CONFIGURED', 'OPENROUTER_API_KEY is not configured')
  }

  const { mode, messages, body: requestBody } = buildRequestBody(request, pressTime)
  const body = JSON.stringify(requestBody)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), isFreeformMode(mode) ? CUSTOM_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS)

  const requestedModel = env.OPENROUTER_MODEL || DEFAULT_MODEL
  const startedAt = performance.now()
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
    throw new ResearchAssistantError('UPSTREAM_ERROR', 'Failed to reach OpenRouter')
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    throw new ResearchAssistantError('UPSTREAM_ERROR', `OpenRouter responded with status ${res.status}`)
  }

  const data = await res.json()
  const durationMs = Math.round(performance.now() - startedAt)
  // OpenRouter can route `model` to a fallback, so log what actually served
  // the request, not just what we asked for.
  const usageMeta = { requestedModel, model: data?.model ?? requestedModel, durationMs, usage: data?.usage ?? null }

  const message = data?.choices?.[0]?.message
  const raw = message?.content?.trim()
  if (!raw) {
    throw new ResearchAssistantError('EMPTY_ANSWER', 'OpenRouter returned no usable answer')
  }

  const citations = (message.annotations ?? [])
    .filter((a) => a.type === 'url_citation')
    .map((a) => ({ url: a.url_citation.url, title: a.url_citation.title }))

  recordResearchUsage({
    roomSlug,
    mode,
    tokens: usageMeta.usage?.total_tokens ?? null,
    cost: usageMeta.usage?.cost ?? null
  })

  if (isFreeformMode(mode)) {
    const card = {
      provenInTranscript: 0,
      ubiquitousKnowledge: 0,
      outputType: mode,
      mainTakeaway: raw
    }
    await appendResearchEvalLog({
      kind: request.kind,
      mode,
      ...usageMeta,
      messages,
      raw,
      card,
      suppressReason: null,
      usable: true
    }, { env })
    return { answer: serializeResearchCard(card), citations }
  }

  const card = parseResearchCard(raw)
  const reason = suppressReason(card, mode)
  const usable = !reason

  await appendResearchEvalLog({
    kind: request.kind,
    mode,
    ...usageMeta,
    messages,
    raw,
    card,
    suppressReason: reason,
    usable
  }, { env })

  return { answer: serializeResearchCard(usable ? card : null), citations: usable ? citations : [] }
}
