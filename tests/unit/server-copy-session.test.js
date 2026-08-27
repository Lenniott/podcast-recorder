import { describe, it, expect, beforeEach } from 'vitest'
import { hashPassword, makeSessionToken, makeHostClaimToken, makeServerCopyToken } from '../../src/lib/server/auth.js'
import db, { createRoom, _resetDb } from '../../src/lib/server/db.js'
import {
  authorizeServerCopyRequest,
  authorizeServerCopyHostRequest,
  isValidServerCopyClientId
} from '../../src/lib/server/server-copy-session.js'

const SECRET = 'test-secret-do-not-use-in-prod'
const SLUG = 'roomslug01'
const ROOM_PASS = 'room-pass'
const CLIENT_ID = 'client123abc'

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

  it('accepts a valid session cookie plus a valid clientId-owning token for an active room', async () => {
    const passwordHash = await seedRoom()
    const sessionToken = makeSessionToken(SLUG, passwordHash, SECRET)
    const result = authorizeServerCopyRequest({
      slug: SLUG,
      cookies: makeCookies({ [`pr_auth_${SLUG}`]: sessionToken }),
      clientId: CLIENT_ID,
      token: makeServerCopyToken(SLUG, CLIENT_ID, SECRET)
    })
    expect(result.ok).toBe(true)
    expect(result.room.slug).toBe(SLUG)
  })

  // Ticket 11: the room cookie alone (same for every participant) must
  // never be enough — the caller also has to hold the capability token
  // for the specific clientId it's acting on.
  it('rejects a valid session cookie without a clientId-owning token', async () => {
    const passwordHash = await seedRoom()
    const sessionToken = makeSessionToken(SLUG, passwordHash, SECRET)
    const result = authorizeServerCopyRequest({
      slug: SLUG,
      cookies: makeCookies({ [`pr_auth_${SLUG}`]: sessionToken }),
      clientId: CLIENT_ID
      // no token — as if a second room participant reused this clientId
    })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(401)
  })

  it('rejects a token that is valid for a different clientId', async () => {
    const passwordHash = await seedRoom()
    const sessionToken = makeSessionToken(SLUG, passwordHash, SECRET)
    const result = authorizeServerCopyRequest({
      slug: SLUG,
      cookies: makeCookies({ [`pr_auth_${SLUG}`]: sessionToken }),
      clientId: CLIENT_ID,
      token: makeServerCopyToken(SLUG, 'someone-elses-client-id', SECRET)
    })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(401)
  })

  it('rejects a forged/tampered token', async () => {
    const passwordHash = await seedRoom()
    const sessionToken = makeSessionToken(SLUG, passwordHash, SECRET)
    const result = authorizeServerCopyRequest({
      slug: SLUG,
      cookies: makeCookies({ [`pr_auth_${SLUG}`]: sessionToken }),
      clientId: CLIENT_ID,
      token: 'deadbeef'.repeat(8)
    })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(401)
  })
})

describe('authorizeServerCopyHostRequest', () => {
  beforeEach(() => {
    process.env.DB_PATH = ':memory:'
    process.env.SECRET = SECRET
    process.env.ROOM_MAX_AGE_HOURS = '12'
    _resetDb()
  })

  it('rejects a room that does not exist', () => {
    const result = authorizeServerCopyHostRequest({ slug: 'nope', cookies: makeCookies() })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(410)
  })

  it('rejects an expired room the same way as a missing one', async () => {
    await seedRoom({ createdAt: Date.now() - 13 * 60 * 60 * 1000 })
    const result = authorizeServerCopyHostRequest({ slug: SLUG, cookies: makeCookies() })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(410)
  })

  it('rejects a request with no host-claim cookie', async () => {
    await seedRoom()
    const result = authorizeServerCopyHostRequest({ slug: SLUG, cookies: makeCookies() })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(403)
  })

  it('rejects a valid participant session cookie that is not the host-claim cookie', async () => {
    const passwordHash = await seedRoom()
    const token = makeSessionToken(SLUG, passwordHash, SECRET)
    const result = authorizeServerCopyHostRequest({
      slug: SLUG,
      cookies: makeCookies({ [`pr_auth_${SLUG}`]: token })
    })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(403)
  })

  it('accepts a valid host-claim cookie for an active room and returns the room row', async () => {
    const passwordHash = await seedRoom()
    const hostToken = makeHostClaimToken(SLUG, passwordHash, SECRET)
    const result = authorizeServerCopyHostRequest({
      slug: SLUG,
      cookies: makeCookies({ [`pr_host_${SLUG}`]: hostToken })
    })
    expect(result.ok).toBe(true)
    expect(result.room.slug).toBe(SLUG)
  })
})
