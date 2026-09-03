/**
 * POST /rec/[slug]/research
 */
import { json } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'
import { verifySessionToken, getHostClaim } from '$lib/server/auth.js'
import { getActiveRoomBySlug, getResearchPrompt } from '$lib/server/db.js'
import { askResearchAssistant, ResearchAssistantError } from '$lib/server/research-assistant.js'
import { TURN_ACTION_IDS } from '$lib/research/research-card.js'

const AUTH_COOKIE = (slug) => `pr_auth_${slug}`

const MAX_QUERY_LENGTH = 500
const MAX_TEXT_LENGTH = 20_000
const TURN_ACTION_ID_SET = new Set(TURN_ACTION_IDS)

function isOptionalString(value, maxLength) {
  return value == null || (typeof value === 'string' && value.length <= maxLength)
}

function validateRequestBody(body) {
  if (!body || typeof body !== 'object') return null

  if (body.kind === 'voice') {
    if (!isOptionalString(body.query, MAX_QUERY_LENGTH)) return null
    if (!isOptionalString(body.context, MAX_TEXT_LENGTH)) return null
    if (!isOptionalString(body.notes, MAX_TEXT_LENGTH)) return null
    // currentTab/transcript are Placeholder ingredients only (see
    // CONTEXT.md) — substituted into `query` in research-assistant.js when
    // the asker wrote {current_tab}/{transcript} themselves, never added
    // to the request automatically.
    if (!isOptionalString(body.currentTab, MAX_TEXT_LENGTH)) return null
    if (!isOptionalString(body.transcript, MAX_TEXT_LENGTH)) return null
    return {
      kind: 'voice',
      query: body.query ?? null,
      context: body.context ?? '',
      notes: body.notes ?? '',
      currentTab: body.currentTab ?? '',
      transcript: body.transcript ?? ''
    }
  }

  if (body.kind === 'turnAction') {
    if (!TURN_ACTION_ID_SET.has(body.actionId)) return null
    if (typeof body.focus !== 'string' || body.focus.length === 0 || body.focus.length > MAX_TEXT_LENGTH) return null
    if (!isOptionalString(body.grounding, MAX_TEXT_LENGTH)) return null
    return { kind: 'turnAction', actionId: body.actionId, focus: body.focus, grounding: body.grounding ?? '' }
  }

  if (body.kind === 'custom') {
    if (typeof body.text !== 'string' || body.text.length === 0 || body.text.length > MAX_TEXT_LENGTH) return null
    if (!isOptionalString(body.transcript, MAX_TEXT_LENGTH)) return null
    return { kind: 'custom', text: body.text, transcript: body.transcript ?? '' }
  }

  return null
}

export async function POST({ params, request, cookies, fetch }) {
  const { slug } = params

  const room = getActiveRoomBySlug(slug)
  if (!room) return json({ error: 'room-unavailable' }, { status: 410 })

  const sessionToken = cookies.get(AUTH_COOKIE(slug))
  if (!verifySessionToken(sessionToken, slug, room.password_hash, env.SECRET)) {
    return json({ error: 'unauthorized' }, { status: 401 })
  }

  let body
  try {
    body = await request.json()
  } catch {
    body = null
  }
  const validated = validateRequestBody(body)
  if (!validated) return json({ error: 'invalid-request' }, { status: 400 })

  if (validated.kind === 'custom') {
    // Same gate as ws-rooms.js's research_ask/research_remove — Guest
    // Research Access covers Custom exactly like Ask and Turn Actions, no
    // special-case host-only rule of its own (see CONTEXT.md).
    const isHost = !!getHostClaim(slug, cookies, room, env.SECRET)
    if (!isHost && !room.guest_ai_allowed) {
      return json({ error: 'forbidden' }, { status: 403 })
    }
    validated.instruction = getResearchPrompt()
  }

  try {
    const { answer, citations } = await askResearchAssistant(validated, { fetchImpl: fetch })
    return json({ answer, citations })
  } catch (e) {
    return json({ error: mapErrorReason(e) }, { status: mapErrorStatus(e) })
  }
}

const ERROR_STATUS_BY_CODE = {
  NOT_CONFIGURED: 500,
  TIMEOUT: 504,
  UPSTREAM_ERROR: 502,
  EMPTY_ANSWER: 502
}

function mapErrorStatus(e) {
  if (e instanceof ResearchAssistantError) return ERROR_STATUS_BY_CODE[e.code] ?? 500
  return 500
}

function mapErrorReason(e) {
  if (e instanceof ResearchAssistantError && ERROR_STATUS_BY_CODE[e.code]) return e.code
  return 'internal-error'
}
