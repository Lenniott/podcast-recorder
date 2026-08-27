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
 *
 * That room cookie is identical for every participant in the room, so on
 * its own it only proves "this caller is in the room" — never "this
 * caller owns the `clientId` in the request" (ticket 11: bind
 * server-copy clientId to owner). `clientId` is client-generated and
 * broadcast to every peer as ordinary presence data, so it is not a
 * secret either. The missing piece is `token`: a `(slug, clientId)`-scoped
 * capability token minted by the WS room server the moment a connection's
 * `'join'` claims that `clientId` (`./ws-rooms.js`) and handed back only
 * on that same connection (see `./auth.js`'s `makeServerCopyToken` doc
 * comment). Verifying it here is what actually closes the IDOR: a request
 * is authorized only if the caller both holds the room cookie AND holds
 * the capability token for the exact `clientId` it's acting on.
 */
import { env } from '$env/dynamic/private'
import { getActiveRoomBySlug } from './db.js'
import { verifySessionToken, verifyServerCopyToken, getHostClaim } from './auth.js'

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
 * unavailable/expired/deleted room, 401 for a missing/invalid session or
 * a `clientId`/`token` mismatch — see the module doc comment above for
 * why both are required).
 *
 * `clientId`/`token` are optional parameters so callers testing only the
 * room-active/room-cookie checks don't have to pass them — but omitting
 * either one always fails the ownership check below, same as a wrong
 * value would. (`authorizeServerCopyHostRequest` below is untouched by
 * ticket 11 — it never dealt in per-`clientId` ownership.)
 */
export function authorizeServerCopyRequest({ slug, cookies, clientId, token }) {
  const room = getActiveRoomBySlug(slug)
  if (!room) return { ok: false, status: 410, reason: 'room-unavailable' }

  const sessionToken = cookies.get(AUTH_COOKIE(slug))
  if (!verifySessionToken(sessionToken, slug, room.password_hash, env.SECRET)) {
    return { ok: false, status: 401, reason: 'unauthorized' }
  }

  if (!verifyServerCopyToken(token, slug, clientId, env.SECRET)) {
    return { ok: false, status: 401, reason: 'clientid-mismatch' }
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
