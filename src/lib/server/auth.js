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

export function generateSlug() {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789'
  const bytes = randomBytes(10)
  let result = ''
  for (let i = 0; i < 10; i++) {
    result += chars[bytes[i] % chars.length]
  }
  return result
}
