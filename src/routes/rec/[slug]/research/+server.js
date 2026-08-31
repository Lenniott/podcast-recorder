/**
 * POST /rec/[slug]/research
 *
 * The one endpoint the browser calls to ask the Research Assistant
 * something (ticket 02) — either a Voice Trigger lookup or a Quick Action.
 * Gated by the same per-room session cookie the rest of `/rec/[slug]`
 * already uses (`$lib/server/auth.js`'s `verifySessionToken`).
 *
 * With `askResearchAssistant` (`$lib/server/research-assistant.js`) doing
 * the real work, this route is exactly what the ticket asks for: check
 * auth, check the request looks like a valid ask, call the Client, map
 * its result or one of its typed errors to an HTTP response. It never
 * throws an unhandled exception for any input, and never lets the
 * OPENROUTER_API_KEY reach the browser.
 */
import { json } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'
import { verifySessionToken } from '$lib/server/auth.js'
import { getActiveRoomBySlug } from '$lib/server/db.js'
import { askResearchAssistant, ResearchAssistantError } from '$lib/server/research-assistant.js'

const AUTH_COOKIE = (slug) => `pr_auth_${slug}`

// Reasonable size/shape limits (ticket 02) — generous enough for real
// conversation/notes/tab text, but bounded so a malformed or abusive body
// can't be used to build an unbounded prompt.
const MAX_QUERY_LENGTH = 500
const MAX_TEXT_LENGTH = 20_000
const QUICK_ACTION_IDS = new Set(['define', 'keyFacts', 'factCheck', 'findExamples', 'analyze'])

function isOptionalString(value, maxLength) {
  return value == null || (typeof value === 'string' && value.length <= maxLength)
}

/** Returns a normalized, safe-to-forward request object, or `null` for a
 *  body that doesn't look like a valid ask. */
function validateRequestBody(body) {
  if (!body || typeof body !== 'object') return null

  if (body.kind === 'voice') {
    if (!isOptionalString(body.query, MAX_QUERY_LENGTH)) return null
    if (!isOptionalString(body.context, MAX_TEXT_LENGTH)) return null
    if (!isOptionalString(body.notes, MAX_TEXT_LENGTH)) return null
    return { kind: 'voice', query: body.query ?? null, context: body.context ?? '', notes: body.notes ?? '' }
  }

  if (body.kind === 'quickAction') {
    if (!QUICK_ACTION_IDS.has(body.actionId)) return null
    if (typeof body.text !== 'string' || body.text.length === 0 || body.text.length > MAX_TEXT_LENGTH) return null
    return { kind: 'quickAction', actionId: body.actionId, text: body.text }
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

  try {
    const { answer, citations } = await askResearchAssistant(validated, { fetchImpl: fetch })
    return json({ answer, citations })
  } catch (e) {
    return json({ error: mapErrorReason(e) }, { status: mapErrorStatus(e) })
  }
}

// Maps each of the Research Assistant Client's named error kinds to an
// HTTP status a caller can act on — never the Client's own `message`
// (which is never the API key itself, but is still not something worth
// forwarding to the browser as a matter of policy: it's diagnostic text
// meant for logs, not a response body). Anything that isn't a recognized
// ResearchAssistantError (a bug, an unexpected throw) still gets mapped
// here rather than propagating — this route must never throw unhandled.
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
