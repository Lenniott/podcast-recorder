/**
 * Research Assistant Client — one entry point, `askResearchAssistant(request)`,
 * turns a lookup into `{ answer, citations }`. Callers never see prompt text.
 */
import { env } from '$env/dynamic/private'
import { serializeResearchCard } from '../research/research-card.js'
import { appendResearchEvalLog } from './research-eval-log.js'
import { recordResearchUsage } from './db.js'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const DEFAULT_MODEL = 'openai/gpt-4o-mini'
// Every request is freeform now (ADR-0008/ticket 07 retired the fixed
// Turn Action modes, which used a shorter timeout for their smaller,
// structured-schema replies) — one timeout for every call.
const REQUEST_TIMEOUT_MS = 45_000

export class ResearchAssistantError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ResearchAssistantError'
    this.code = code
  }
}

// Placeholder substitution (see CONTEXT.md) — the one place every
// Placeholder gets resolved, so every free-text field that accepts them (a
// Custom Prompt's template, an Ask question) goes through this same rule
// rather than each caller splicing strings its own way. A placeholder with
// no value supplied (e.g. `{transcript}` before any transcript exists, or
// `{selection}` when the prompt wasn't triggered from a highlight) resolves
// to '' — silently, not an error: the prompt's own author is what decides
// whether that's worth noting. Text that isn't a known placeholder is left
// exactly as written, so prose containing braces survives untouched.
const PLACEHOLDERS = {
  current_tab: 'currentTab',
  transcript: 'transcript',
  selection: 'selection',
  video_title: 'videoTitle',
  current_time: 'currentTime',
  latest_transcript: 'latestTranscript'
}

/** The Placeholder names a prompt author can write, for UI/docs to list. */
export const PLACEHOLDER_NAMES = Object.keys(PLACEHOLDERS)

// `{latest_transcript}`'s window (see CONTEXT.md) — a bounded *recent* slice,
// deliberately distinct from `{transcript}`'s everything-so-far. 700 words is
// the number the design session settled on; it isn't derived from a token
// budget, so don't "fix" it to match one.
export const LATEST_TRANSCRIPT_WORD_LIMIT = 700

/**
 * Last `wordLimit` whitespace-separated words of `transcript`, sliced out of
 * the original string rather than re-joined from a word array — a transcript
 * is newline-separated Turns, and rebuilding it word-by-word would flatten
 * every speaker boundary into one paragraph.
 */
export function latestTranscriptWindow(transcript, wordLimit = LATEST_TRANSCRIPT_WORD_LIMIT) {
  const text = String(transcript ?? '')
  if (!text.trim() || !(wordLimit > 0)) return ''
  const words = [...text.matchAll(/\S+/g)]
  if (words.length <= wordLimit) return text.trim()
  return text.slice(words[words.length - wordLimit].index).trim()
}

/** Same ceiling POST /rec/[slug]/research applies to every Placeholder
 *  ingredient it accepts — one bound, applied wherever a request is built,
 *  rather than a second number that could drift from the route's. */
const MAX_PLACEHOLDER_VALUE_LEN = 20_000

/**
 * The Placeholder names a template actually writes (unknown `{words}` are
 * ignored, exactly as applyPlaceholders leaves them alone).
 */
export function referencedPlaceholders(template) {
  const names = new Set()
  for (const [, name] of String(template || '').matchAll(/\{(\w+)\}/g)) {
    if (PLACEHOLDERS[name]) names.add(name)
  }
  return names
}

/**
 * Builds the `custom` request for ONE Custom Prompt triggered from a
 * highlighted excerpt (ADR-0008, ticket 05) — the generalization of the
 * retired single-Custom builder, which always sent the one global prompt
 * plus the whole active tab.
 *
 * **It carries only the ingredients the template itself references.** This
 * is the ADR's central lesson made structural rather than advisory: a
 * prompt written to reference `{selection}` alone must never be handed the
 * surrounding Notes or the Transcript, because a fixed policy that fed a
 * whole lyric as grounding leaked thematic interpretation the hosts had not
 * yet discussed on air. applyPlaceholders would already refuse to *splice*
 * an unreferenced value into the prompt text; dropping it here means it
 * never reaches the request at all, so there is nothing for a later change
 * to the prompt-assembly code to accidentally start including.
 *
 * `{current_time}` needs no ingredient — research-assistant fills it from
 * the request's own press time.
 *
 * Returns null for an unknown/blank template: the caller decides whether
 * that's an error worth surfacing.
 */
export function buildCustomPromptRequest({
  template,
  selection = '',
  currentTab = '',
  transcript = '',
  videoTitle = ''
} = {}) {
  const instruction = String(template ?? '').trim()
  if (!instruction) return null

  const referenced = referencedPlaceholders(instruction)
  const wants = (name) => referenced.has(name)
  const cap = (value) => String(value ?? '').slice(0, MAX_PLACEHOLDER_VALUE_LEN)

  return {
    kind: 'custom',
    instruction,
    // `text` is where a `custom` request carries `{current_tab}`'s value —
    // see placeholderValues below, which predates this builder.
    text: wants('current_tab') ? cap(currentTab) : '',
    selection: wants('selection') ? cap(selection) : '',
    // `{latest_transcript}` is windowed *from* `{transcript}`'s ingredient
    // (see applyPlaceholders), so referencing either one needs it.
    transcript: wants('transcript') || wants('latest_transcript') ? cap(transcript) : '',
    videoTitle: wants('video_title') ? cap(videoTitle).trim() : '',
    // Logged unsubstituted, so the Eval Log shows the template behind the
    // call and not only what went to the model.
    researchPrompt: instruction
  }
}

export function applyPlaceholders(template, values = {}) {
  // `{latest_transcript}` is derived from the transcript the caller already
  // supplies, so no caller has to window it itself — but an explicit
  // latestTranscript still wins. With no transcript at all it derives to '',
  // which is the same unset-resolves-to-empty rule the others follow.
  const resolved =
    values.latestTranscript == null
      ? { ...values, latestTranscript: latestTranscriptWindow(values.transcript) }
      : values

  return String(template || '').replace(/\{(\w+)\}/g, (match, name) => {
    const key = PLACEHOLDERS[name]
    return key ? String(resolved[key] ?? '') : match
  })
}

/**
 * Pulls the Placeholder ingredients off a request. `custom` carries the
 * active tab's body as `text` and `voice` as `currentTab` — the two request
 * shapes predate each other; everything else is named the same in both.
 * `{current_time}` is the one Placeholder no caller supplies: it's the
 * request's own press time, so it's filled in here.
 */
function placeholderValues(request, pressTimeIso) {
  return {
    currentTab: request.kind === 'custom' ? request.text : request.currentTab,
    transcript: request.transcript,
    selection: request.selection,
    videoTitle: request.videoTitle,
    currentTime: pressTimeIso
  }
}

function buildMessages(request, pressTime = new Date()) {
  const pressTimeIso = pressTime.toISOString()

  if (request.kind === 'custom') {
    // A Custom Prompt's template (see CONTEXT.md) is the whole request — no
    // hardcoded stage structure wraps it any more (see ADR-0006). Whatever
    // Placeholders the prompt's own text references are resolved here, the
    // one seam every Placeholder goes through (applyPlaceholders above).
    const template = String(request.instruction || '').trim()
    if (!template) {
      throw new ResearchAssistantError('INVALID_REQUEST', 'Custom Prompt is not configured')
    }
    const instruction = applyPlaceholders(template, placeholderValues(request, pressTimeIso))
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
    const query = applyPlaceholders(request.query, placeholderValues(request, pressTimeIso))
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

// The unsubstituted prompt behind this call (see CONTEXT.md's Custom
// Prompt) — logged even when it was Ask (no saved prompt at all), so the
// Eval Log is a snapshot of what was configured, not only what went to
// the model.
function researchPromptForLog(request) {
  if (request.kind === 'custom') return String(request.instruction || '')
  return String(request.researchPrompt ?? '')
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
      usage: { include: true }
    }
  }
}

export async function askResearchAssistant(request, { fetchImpl = fetch, pressTime = new Date(), roomSlug = null } = {}) {
  const apiKey = env.OPENROUTER_API_KEY
  if (!apiKey) {
    throw new ResearchAssistantError('NOT_CONFIGURED', 'OPENROUTER_API_KEY is not configured')
  }

  const { mode, messages, body: requestBody } = buildRequestBody(request, pressTime)
  const body = JSON.stringify(requestBody)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

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

  // Every mode is freeform now (ADR-0008/ticket 07) — the model's raw reply
  // *is* the takeaway, with none of the retired structured modes' score-
  // threshold suppression to apply.
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
    researchPrompt: researchPromptForLog(request),
    messages,
    raw,
    card,
    suppressReason: null,
    usable: true
  }, { env })
  return { answer: serializeResearchCard(card), citations }
}
