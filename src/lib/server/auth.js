import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { hash as bcryptHash, compare as bcryptCompare } from 'bcryptjs'

// SECRET is read lazily so it works in both:
// - SvelteKit SSR context (process.env populated by adapter-node / --env-file)
// - Vite dev SSR context (process.env may be set by Vite from .env)
// Route files that need it pass it in explicitly via $env/dynamic/private.
function getSecret() {
  const secret = process.env.SECRET
  if (!secret) throw new Error('SECRET environment variable is not set')
  return secret
}

export async function hashPassword(password) {
  return bcryptHash(password, 10)
}

export async function verifyPassword(password, hash) {
  return bcryptCompare(password, hash)
}

// Shared shape behind every HMAC token this module issues (session,
// host-claim, server-copy): hash a fixed message under SECRET to make it,
// timing-safe-compare against a freshly recomputed expectation to verify
// it. Consolidated here so the three token kinds below can't drift on
// this mechanics — each pair only supplies its own message format.
function hmacHex(secret, message) {
  return createHmac('sha256', secret).update(message).digest('hex')
}

function timingSafeEqualHex(token, expectedHex) {
  try {
    return timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(expectedHex, 'hex'))
  } catch {
    return false
  }
}

export function makeSessionToken(slug, passwordHash, secret = getSecret()) {
  return hmacHex(secret, `${slug}:${passwordHash}`)
}

export function verifySessionToken(token, slug, passwordHash, secret = getSecret()) {
  if (!token || !slug || !passwordHash) return false
  return timingSafeEqualHex(token, makeSessionToken(slug, passwordHash, secret))
}

export function makeHostClaimToken(slug, passwordHash, secret = getSecret()) {
  return hmacHex(secret, `host:${slug}:${passwordHash}`)
}

export function verifyHostClaimToken(token, slug, passwordHash, secret = getSecret()) {
  if (!token || !slug || !passwordHash) return false
  return timingSafeEqualHex(token, makeHostClaimToken(slug, passwordHash, secret))
}

/**
 * `(slug, clientId)`-scoped capability token — the fix for ticket 11
 * (bind server-copy clientId to owner). Minted once by the WS room server
 * (`./ws-rooms.js`) the moment a connection's `'join'` establishes its
 * `clientId`, and sent back *only* on that connection — never broadcast,
 * since `clientId` itself is broadcast presence data and is not a secret.
 * The client threads it through every `server-copy/{session,chunks,
 * finalize}` request (`$lib/server-copy-upload.js`), and
 * `authorizeServerCopyRequest` (`./server-copy-session.js`) verifies it
 * against the `clientId` in the request, proving the caller is the
 * connection that actually owns that `clientId` — something the room's
 * shared session cookie alone can never prove, since every participant
 * holds the identical cookie.
 *
 * Stateless by design, same as every other token here: no server-side
 * session store, verifiable from `(slug, clientId, secret)` alone.
 */
export function makeServerCopyToken(slug, clientId, secret = getSecret()) {
  return hmacHex(secret, `servercopy:${slug}:${clientId}`)
}

export function verifyServerCopyToken(token, slug, clientId, secret = getSecret()) {
  if (!token || !slug || !clientId) return false
  return timingSafeEqualHex(token, makeServerCopyToken(slug, clientId, secret))
}

/**
 * Shared "is this connection the host?" check, used everywhere host
 * identity is established: `/rec/[slug]`'s page load
 * (`src/routes/rec/[slug]/+page.server.js`), the WS room server
 * (`src/lib/server/ws-rooms.js`), and the server-copy download gate
 * (`src/lib/server/server-copy-session.js`'s `authorizeServerCopyHostRequest`).
 *
 * Reads the `pr_host_<slug>` cookie, verifies it with `verifyHostClaimToken`
 * against `room`'s password hash, and returns a plain boolean — never
 * throws, never redirects, never shapes a response. `room` may be `null`
 * (an unknown, expired, or deleted room), in which case this always
 * returns `false`. Each call site decides what to do with the result
 * (redirect, WS role, HTTP status) since that differs by context.
 *
 * `cookies` needs only a `.get(name)` method — both SvelteKit's `Cookies`
 * and the plain `Map` `ws-rooms.js` parses request headers into satisfy
 * this.
 */
export function getHostClaim(slug, cookies, room, secret = getSecret()) {
  if (!room) return false
  const token = cookies.get(`pr_host_${slug}`)
  return verifyHostClaimToken(token, slug, room.password_hash, secret)
}

export function generateSlug() {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789'
  const bytes = randomBytes(10)
  let result = ''
  for (let i = 0; i < 10; i++) {
    result += chars[bytes[i] % chars.length]
  }
  return result
}
