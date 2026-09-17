/**
 * Research Assistant Client — one entry point, `askResearchAssistant(request)`,
 * turns a lookup into `{ answer, citations, blocks }`. Callers never see
 * prompt text. `blocks` (defined by research-blocks.js) is a parsed Block
 * array for typed Ask and for a `custom` request whose `outputFormat` is
 * `'blocks'`; it is
 * null for a text-format Custom Prompt or a Blocks reply with nothing to
 * report. `answer` is always populated (a flattened-text
 * fallback for a blocks reply), so an existing caller that only reads
 * `answer` keeps working unchanged.
 *
 * Deliberately `process.env`, not `$env/dynamic/private` — same reasoning as
 * auth.js's getSecret(): this module is loaded from ws-rooms.js (ADR-0008,
 * ticket 05's annotation_ask calls askResearchAssistant directly, server-side).
 * ws-rooms.js is only ever loaded by
 * server.js/server-ws-dev.js — plain Node processes outside Vite/SvelteKit's
 * module graph — where `$env/dynamic/private` is not a real package and
 * cannot resolve at all (`ERR_MODULE_NOT_FOUND`), not even to an empty
 * object. `$env/dynamic/private` is just a proxy over `process.env` at
 * runtime in every context that does support it, so this is the same values,
 * read in a way that actually works everywhere this module runs.
 */
import { serializeResearchCard } from '../research/research-card.js'
import { blocksResponseSchema, parseBlocks, flattenBlocksToText } from '../research/research-blocks.js'
import { PLACEHOLDERS, PLACEHOLDER_NAMES, referencedPlaceholders } from '../research/placeholders.js'
import { appendResearchEvalLog } from './research-eval-log.js'
import { recordResearchUsage } from './db.js'

export { PLACEHOLDER_NAMES, referencedPlaceholders }

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

/** One bound applied wherever a Placeholder-bearing request is built. */
const MAX_PLACEHOLDER_VALUE_LEN = 20_000

export function buildAskRequest({ question, currentTab = '', transcript = '', videoTitle = '' } = {}) {
  const instruction = String(question ?? '').trim()
  if (!instruction) return null

  const referenced = referencedPlaceholders(instruction)
  const wants = (name) => referenced.has(name)
  const cap = (value) => String(value ?? '').slice(0, MAX_PLACEHOLDER_VALUE_LEN)
  return {
    kind: 'ask',
    question: instruction,
    currentTab: wants('current_tab') ? cap(currentTab) : '',
    transcript: wants('transcript') || wants('latest_transcript') ? cap(transcript) : '',
    selection: '',
    videoTitle: wants('video_title') ? cap(videoTitle).trim() : '',
    researchPrompt: instruction,
    outputFormat: 'blocks'
  }
}

/**
 * `{#if name}...{/if}` — keeps the block's text when `name`'s Placeholder
 * resolved to something non-blank, drops the whole block (markers and all)
 * otherwise. An unknown placeholder name is always falsy — a typo should
 * never silently show content gated on nothing. One level only: this does
 * not support nesting one `{#if}` inside another (a non-greedy match pairs
 * each opener with the *next* `{/if}` it finds), because nothing asked for
 * that yet — an `{#if}` written inside another is left partially resolved
 * rather than crashing, but the result won't be what a nested reading of it
 * implies.
 *
 * Runs before the plain `{name}` substitution pass in applyPlaceholders, so
 * a dropped block's own placeholders are simply discarded with it rather
 * than resolved and then thrown away — not that it would matter either way,
 * since both passes read from the same `resolved` values.
 */
function resolveConditionalBlocks(template, resolved) {
  return String(template || '').replace(/\{#if\s+(\w+)\}([\s\S]*?)\{\/if\}/g, (_match, name, body) => {
    const key = PLACEHOLDERS[name]
    const truthy = !!key && String(resolved[key] ?? '').trim() !== ''
    return truthy ? body : ''
  })
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
 *
 * `outputFormat` (see research-blocks.js) is a separate axis from all of
 * the above — it decides *how the reply is shaped* (typed Blocks vs. free
 * text), never what the prompt is allowed to know. Defaults to `'text'` so
 * every existing Custom Prompt keeps behaving exactly as it does today.
 */
export function buildCustomPromptRequest({
  template,
  selection = '',
  currentTab = '',
  transcript = '',
  videoTitle = '',
  outputFormat = 'text'
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
    researchPrompt: instruction,
    outputFormat: outputFormat === 'blocks' ? 'blocks' : 'text'
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

  const withConditionals = resolveConditionalBlocks(template, resolved)

  return withConditionals.replace(/\{(\w+)\}/g, (match, name) => {
    const key = PLACEHOLDERS[name]
    return key ? String(resolved[key] ?? '') : match
  })
}

/**
 * Pulls the Placeholder ingredients off a request. `custom` carries the
 * active tab's body as `text` and `ask` as `currentTab` — the two request
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
    const resolvedTemplate = applyPlaceholders(template, placeholderValues(request, pressTimeIso))
    // Participant context is authored for this one invocation, not part of
    // the saved template language. Append it only after Placeholder
    // substitution so braces the participant typed remain literal text.
    const participantContext = String(request.participantContext || '').trim()
    const instruction = participantContext
      ? `${resolvedTemplate}\n\nParticipant context:\n${participantContext}`
      : resolvedTemplate
    const mode = 'custom'
    return {
      mode,
      messages: [{ role: 'user', content: instruction }]
    }
  }

  if (request.kind === 'ask') {
    // Typed Ask is freeform like Custom: the box text *is* the request.
    // No shared system prompt, no MODE_RULES.ask. Placeholders in the
    // typed text still resolve here.
    const userContent = applyPlaceholders(request.question, placeholderValues(request, pressTimeIso)).trim()
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
  return String(request.question ?? request.researchPrompt ?? '')
}

function boundedLogText(value, max = 1000) {
  if (typeof value !== 'string') return null
  return value.slice(0, max)
}

// Diagnostic shape for the provider boundary. It deliberately records
// structure and bounded error/refusal text, never request headers or the
// API key. This makes an HTTP-200 response with no usable content
// distinguishable from an empty choices array or a structured empty reply.
function providerResponseForLog(data, res, message) {
  const providerError = data?.error
  return {
    status: res?.status ?? null,
    choiceCount: Array.isArray(data?.choices) ? data.choices.length : null,
    finishReason: data?.choices?.[0]?.finish_reason ?? null,
    nativeFinishReason: data?.choices?.[0]?.native_finish_reason ?? null,
    contentType: message ? typeof message.content : null,
    contentLength: typeof message?.content === 'string' ? message.content.length : null,
    refusal: boundedLogText(message?.refusal),
    reasoningLength: typeof message?.reasoning === 'string' ? message.reasoning.length : null,
    error: providerError
      ? {
          code: boundedLogText(String(providerError.code ?? ''), 100),
          message: boundedLogText(String(providerError.message ?? ''))
        }
      : null
  }
}

// Typed Ask always uses Blocks. Custom Prompts choose their saved format.
function wantsBlocks(request) {
  return request.kind === 'ask' || (request.kind === 'custom' && request.outputFormat === 'blocks')
}

/** OpenRouter `provider` pin. Blank OPENROUTER_PROVIDER_ONLY leaves
 *  routing to OpenRouter. A comma-separated list becomes `only`, with
 *  `allow_fallbacks: false` so a miss fails instead of hopping vendors. */
function providerRouting() {
  const only = String(process.env.OPENROUTER_PROVIDER_ONLY || '')
    .split(',')
    .map((slug) => slug.trim())
    .filter(Boolean)
  if (only.length === 0) return {}
  return { provider: { only, allow_fallbacks: false } }
}

function buildRequestBody(request, pressTime) {
  const { mode, messages } = buildMessages(request, pressTime)
  return {
    mode,
    messages,
    body: {
      model: process.env.OPENROUTER_MODEL || DEFAULT_MODEL,
      messages,
      plugins: [{ id: 'web' }],
      // Asks OpenRouter to report actual cost on `usage.cost` — see
      // ADR-0007 — so the Usage Dashboard doesn't need to price each model
      // itself from a maintained table.
      usage: { include: true },
      ...providerRouting(),
      ...(wantsBlocks(request) ? { response_format: blocksResponseSchema() } : {})
    }
  }
}

export async function askResearchAssistant(request, { fetchImpl = fetch, pressTime = new Date(), roomSlug = null } = {}) {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) {
    throw new ResearchAssistantError('NOT_CONFIGURED', 'OPENROUTER_API_KEY is not configured')
  }

  const { mode, messages, body: requestBody } = buildRequestBody(request, pressTime)
  const body = JSON.stringify(requestBody)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  const requestedModel = process.env.OPENROUTER_MODEL || DEFAULT_MODEL
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
  const provider = providerResponseForLog(data, res, message)

  // OpenRouter can bill a request that returns no usable content. Count it
  // before answer validation so the Usage Dashboard never silently drops a
  // paid failure.
  recordResearchUsage({
    roomSlug,
    mode,
    tokens: usageMeta.usage?.total_tokens ?? null,
    cost: usageMeta.usage?.cost ?? null
  })

  if (!raw) {
    await appendResearchEvalLog({
      kind: request.kind,
      mode,
      ...usageMeta,
      researchPrompt: researchPromptForLog(request),
      messages,
      raw: null,
      card: null,
      suppressReason: 'empty-answer',
      usable: false,
      error: { code: 'EMPTY_ANSWER', message: 'OpenRouter returned no usable answer' },
      provider
    })
    throw new ResearchAssistantError('EMPTY_ANSWER', 'OpenRouter returned no usable answer')
  }

  const citations = (message.annotations ?? [])
    .filter((a) => a.type === 'url_citation')
    .map((a) => ({ url: a.url_citation.url, title: a.url_citation.title }))

  // A `'blocks'`-format request's raw reply is the schema's JSON, not prose
  // — parse it into typed Blocks instead of treating it as the takeaway
  // itself. `blocks` is null for "nothing to report" (parseBlocks' own
  // empty-means-null convention, mirroring normalizeEmptyCard's empty-
  // mainTakeaway rule below) as well as for every non-blocks request.
  const blocks = wantsBlocks(request) ? parseBlocks(raw) : null
  // The Eval Log's `card`/`raw` fields only know how to hold a flat string,
  // so a structured reply still gets a flattened-text fallback there — see
  // ticket 01's own note that carrying both is simplest. Note this reads
  // `wantsBlocks(request)`, not `blocks` itself: an empty/unparseable
  // blocks reply must still flatten to '' ("nothing to report," same
  // convention as every other freeform mode), not fall back to raw JSON
  // that was never meant to be read as prose.
  const mainTakeaway = wantsBlocks(request) ? flattenBlocksToText(blocks) : raw

  // Every mode is freeform now (ADR-0008/ticket 07) — the model's raw reply
  // *is* the takeaway, with none of the retired structured modes' score-
  // threshold suppression to apply.
  const card = {
    provenInTranscript: 0,
    ubiquitousKnowledge: 0,
    outputType: mode,
    mainTakeaway
  }
  const usable = !!mainTakeaway
  await appendResearchEvalLog({
    kind: request.kind,
    mode,
    ...usageMeta,
    researchPrompt: researchPromptForLog(request),
    messages,
    raw,
    card,
    suppressReason: usable ? null : 'empty-answer',
    usable,
    error: usable
      ? null
      : { code: 'EMPTY_ANSWER', message: 'OpenRouter returned an empty structured answer' },
    provider
  })
  if (!usable) {
    throw new ResearchAssistantError('EMPTY_ANSWER', 'OpenRouter returned an empty structured answer')
  }
  return { answer: serializeResearchCard(card), citations, blocks }
}
