/**
 * Research Assistant Client — one entry point, `askResearchAssistant(request)`,
 * turns a lookup into `{ answer, citations }`. Callers never see prompt text.
 */
import { env } from '$env/dynamic/private'
import { matchesMode, MODE_RULES, MODES, parseResearchCard, serializeResearchCard, shouldSuppress } from '../research-card.js'
import { INTERPRETATION_MODE_PROMPT } from './interpretation-mode-prompt.js'
import { appendResearchEvalLog } from './research-eval-log.js'

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
contextSummary: max 12 words. The specific claim selected, not the whole sentence.
mainTakeaway: max 35 words. One paragraph. Stated as fact. No hedging.

Hard rules:
- No preamble, no restating the question, no closing remarks.
- Never cite a source inline — no URLs, no markdown links, no "according to X". Sources you used are reported separately and automatically; naming or linking one yourself is redundant and against the word limit.
- If nothing survives the mode rule, leave contextSummary and mainTakeaway both empty strings and the scores 0 — that combination means "nothing to report".`
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
    const instruction = String(request.instruction || INTERPRETATION_MODE_PROMPT).trim()
    if (!instruction) {
      throw new ResearchAssistantError('INVALID_REQUEST', 'Custom instruction is missing')
    }
    const lyrics = request.text
    const transcript = String(request.transcript || '').trim()
    const mode = 'custom'
    return {
      mode,
      messages: [
        { role: 'system', content: instruction },
        {
          role: 'user',
          content: [
            'STAGE 1 INPUT — lyrics only. Complete and lock Stage 1 before reading Stage 2.',
            `LYRICS:\n${lyrics}`,
            transcript
              ? `---\nSTAGE 2 INPUT — host/guest reading. Use only after Stage 1 is locked.\nTRANSCRIPT:\n${transcript}`
              : '---\nSTAGE 2 INPUT — no transcript was captured. Complete Stage 1; for Stage 2 note that the human reading is missing.'
          ].join('\n\n')
        }
      ]
    }
  }

  if (request.kind === 'voice') {
    const { query, context, notes } = request
    const mode = 'ask'
    return {
      mode,
      messages: [
        { role: 'system', content: buildSystemPrompt(pressTimeIso, mode) },
        {
          role: 'user',
          content: [
            query ? `Question asked: "${query}"` : '',
            context ? `FOCUS TURN:\n${context}` : '',
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

// Structured-output schema for every mode except `custom` — Interpretation
// Mode has its own prompt (INTERPRETATION_MODE_PROMPT) and its reply is
// used as freeform prose (see askResearchAssistant's `mode === 'custom'`
// branch), not parsed field-by-field, so it isn't forced through this.
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
          contextSummary: { type: 'string' },
          mainTakeaway: { type: 'string' }
        },
        required: ['provenInTranscript', 'ubiquitousKnowledge', 'outputType', 'contextSummary', 'mainTakeaway'],
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
      ...(mode === 'custom' ? {} : { response_format: researchCardSchema(mode) })
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

export async function askResearchAssistant(request, { fetchImpl = fetch, pressTime = new Date() } = {}) {
  const apiKey = env.OPENROUTER_API_KEY
  if (!apiKey) {
    throw new ResearchAssistantError('NOT_CONFIGURED', 'OPENROUTER_API_KEY is not configured')
  }

  const { mode, messages, body: requestBody } = buildRequestBody(request, pressTime)
  const body = JSON.stringify(requestBody)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), mode === 'custom' ? CUSTOM_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS)

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

  if (mode === 'custom') {
    const card = {
      provenInTranscript: 0,
      ubiquitousKnowledge: 0,
      outputType: 'custom',
      contextSummary: 'Interpretation',
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
