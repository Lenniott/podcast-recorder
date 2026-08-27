/**
 * Shared authorization gate for the server-copy upload endpoints
 * (`server-copy/session` and `server-copy/chunks`) — centralized so the
 * two routes can never drift on what counts as an authorized upload.
 *
 * A server-copy upload is only ever authorized for a room that is still
 * active — `getActiveRoomBySlug` already folds in expiry (ticket 02: tie
 * server copies to room lifetime), so an expired or deleted room is
 * rejected here exactly like a room that never existed, with no separate
 * retention clock to maintain. On top of that, the caller must hold the
 * same per-room session cookie the rest of the app already uses to gate
 * access to `/rec/[slug]` — no new auth mechanism.
 */
import { env } from '$env/dynamic/private'
import { getActiveRoomBySlug } from './db.js'
import { verifySessionToken, getHostClaim } from './auth.js'

const AUTH_COOKIE = (slug) => `pr_auth_${slug}`

// Matches the clientIds the client actually generates (see rec/[slug]/+page.svelte:
// two base-36 random strings concatenated) — also doubles as the file-path
// safety net's first line of defense, ahead of server-copy-storage's own
// resolve()-based checks.
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

export function isValidServerCopyClientId(clientId) {
  return CLIENT_ID_RE.test(String(clientId ?? ''))
}

/**
 * Returns `{ ok: true, room }` for an authorized request, or
 * `{ ok: false, status, reason }` for one that must be rejected — `status`
 * is the HTTP status the route should respond with (410 for an
 * unavailable/expired/deleted room, 401 for a missing/invalid session).
 */
export function authorizeServerCopyRequest({ slug, cookies }) {
  const room = getActiveRoomBySlug(slug)
  if (!room) return { ok: false, status: 410, reason: 'room-unavailable' }

  const token = cookies.get(AUTH_COOKIE(slug))
  if (!verifySessionToken(token, slug, room.password_hash, env.SECRET)) {
    return { ok: false, status: 401, reason: 'unauthorized' }
  }

  return { ok: true, room }
}

/**
 * Host-only authorization gate for the server-copy download route
 * (`server-copy/download`). Same room-active check as
 * authorizeServerCopyRequest above, but instead of any participant's
 * session cookie, requires the room's host-claim cookie — checked via the
 * shared `getHostClaim` helper (`./auth.js`), the same one `/rec/[slug]`'s
 * page load (`+page.server.js`) and the WS room server (`ws-rooms.js`)
 * already use to establish "this connection is the host," reused here
 * rather than inventing a third definition of "host."
 */
export function authorizeServerCopyHostRequest({ slug, cookies }) {
  const room = getActiveRoomBySlug(slug)
  if (!room) return { ok: false, status: 410, reason: 'room-unavailable' }

  if (!getHostClaim(slug, cookies, room, env.SECRET)) {
    return { ok: false, status: 403, reason: 'not-host' }
  }

  return { ok: true, room }
}
