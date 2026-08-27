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

export function makeSessionToken(slug, passwordHash, secret = getSecret()) {
  return createHmac('sha256', secret)
    .update(`${slug}:${passwordHash}`)
    .digest('hex')
}

export function verifySessionToken(token, slug, passwordHash, secret = getSecret()) {
  if (!token || !slug || !passwordHash) return false
  const expected = makeSessionToken(slug, passwordHash, secret)
  try {
    return timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(expected, 'hex'))
  } catch {
    return false
  }
}

export function makeHostClaimToken(slug, passwordHash, secret = getSecret()) {
  return createHmac('sha256', secret)
    .update(`host:${slug}:${passwordHash}`)
    .digest('hex')
}

export function verifyHostClaimToken(token, slug, passwordHash, secret = getSecret()) {
  if (!token || !slug || !passwordHash) return false
  const expected = makeHostClaimToken(slug, passwordHash, secret)
  try {
    return timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(expected, 'hex'))
  } catch {
    return false
  }
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
