import { describe, it, expect, beforeEach } from 'vitest'
import { hashPassword, makeSessionToken } from '../../src/lib/server/auth.js'
import db, { createRoom, _resetDb } from '../../src/lib/server/db.js'
import {
  authorizeServerCopyRequest,
  isValidServerCopyClientId
} from '../../src/lib/server/server-copy-session.js'

const SECRET = 'test-secret-do-not-use-in-prod'
const SLUG = 'roomslug01'
const ROOM_PASS = 'room-pass'

function makeCookies(seed = {}) {
  const jar = new Map(Object.entries(seed))
  return { get: (name) => jar.get(name) }
}

async function seedRoom({ createdAt } = {}) {
  const passwordHash = await hashPassword(ROOM_PASS)
  createRoom({ slug: SLUG, name: 'Test Episode', passwordHash })
  if (createdAt != null) {
    db.getDb().prepare('UPDATE rooms SET created_at = ? WHERE slug = ?').run(createdAt, SLUG)
  }
  return passwordHash
}

describe('isValidServerCopyClientId', () => {
  it('accepts the alphanumeric ids the client actually generates', () => {
    expect(isValidServerCopyClientId('abc123def456')).toBe(true)
  })

  it('rejects empty, missing, or path-traversal-shaped ids', () => {
    expect(isValidServerCopyClientId('')).toBe(false)
    expect(isValidServerCopyClientId(undefined)).toBe(false)
    expect(isValidServerCopyClientId('../../etc')).toBe(false)
    expect(isValidServerCopyClientId('a/b')).toBe(false)
  })
})

describe('authorizeServerCopyRequest', () => {
  beforeEach(() => {
    process.env.DB_PATH = ':memory:'
    process.env.SECRET = SECRET
    process.env.ROOM_MAX_AGE_HOURS = '12'
    _resetDb()
  })

  it('rejects a room that does not exist', () => {
    const result = authorizeServerCopyRequest({ slug: 'nope', cookies: makeCookies() })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(410)
  })

  it('rejects an expired room the same way as a missing one — ties upload to room lifetime', async () => {
    await seedRoom({ createdAt: Date.now() - 13 * 60 * 60 * 1000 }) // older than 12h max age
    const result = authorizeServerCopyRequest({ slug: SLUG, cookies: makeCookies() })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(410)
  })

  it('rejects a request with no/invalid session cookie for the room', async () => {
    await seedRoom()
    const result = authorizeServerCopyRequest({
      slug: SLUG,
      cookies: makeCookies({ [`pr_auth_${SLUG}`]: 'garbage' })
    })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(401)
  })

  it('accepts a valid session cookie for an active room and returns the room row', async () => {
    const passwordHash = await seedRoom()
    const token = makeSessionToken(SLUG, passwordHash, SECRET)
    const result = authorizeServerCopyRequest({
      slug: SLUG,
      cookies: makeCookies({ [`pr_auth_${SLUG}`]: token })
    })
    expect(result.ok).toBe(true)
    expect(result.room.slug).toBe(SLUG)
  })
})
