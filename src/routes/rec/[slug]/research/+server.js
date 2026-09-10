/**
 * POST /rec/[slug]/research
 */
import { json } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'
import { verifySessionToken } from '$lib/server/auth.js'
import { getActiveRoomBySlug } from '$lib/server/db.js'
import { askResearchAssistant, ResearchAssistantError } from '$lib/server/research-assistant.js'

const AUTH_COOKIE = (slug) => `pr_auth_${slug}`

const MAX_QUERY_LENGTH = 500
const MAX_TEXT_LENGTH = 20_000

function isOptionalString(value, maxLength) {
  return value == null || (typeof value === 'string' && value.length <= maxLength)
}

function validateRequestBody(body) {
  if (!body || typeof body !== 'object') return null

  if (body.kind === 'voice') {
    if (!isOptionalString(body.query, MAX_QUERY_LENGTH)) return null
    if (!isOptionalString(body.context, MAX_TEXT_LENGTH)) return null
    if (!isOptionalString(body.notes, MAX_TEXT_LENGTH)) return null
    // currentTab/transcript/videoTitle/selection are Placeholder ingredients
    // only (see CONTEXT.md) — substituted into `query` in
    // research-assistant.js when the asker wrote the matching Placeholder
    // themselves, never added to the request automatically. One an asker
    // didn't reference costs nothing; one they referenced with nothing to
    // fill it resolves to ''.
    if (!isOptionalString(body.currentTab, MAX_TEXT_LENGTH)) return null
    if (!isOptionalString(body.transcript, MAX_TEXT_LENGTH)) return null
    if (!isOptionalString(body.videoTitle, MAX_TEXT_LENGTH)) return null
    if (!isOptionalString(body.selection, MAX_TEXT_LENGTH)) return null
    return {
      kind: 'voice',
      query: body.query ?? null,
      context: body.context ?? '',
      notes: body.notes ?? '',
      currentTab: body.currentTab ?? '',
      transcript: body.transcript ?? '',
      videoTitle: body.videoTitle ?? '',
      selection: body.selection ?? ''
    }
  }

  // `turnAction` (the fixed Definition/Facts/Answer path) and this route's
  // own `custom` kind (the single global Custom button that ran the first
  // configured prompt against the whole active tab) are both retired —
  // ADR-0008, ticket 07. A Custom Prompt triggered from a highlight is
  // resolved and run entirely server-side from the `annotation_ask` WS
  // message (see ws-rooms.js) — it never reaches this HTTP route at all.
  // Typed Ask (`voice`, above) is the only kind this route still accepts.

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

  try {
    const { answer, citations } = await askResearchAssistant(validated, { fetchImpl: fetch, roomSlug: slug })
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
