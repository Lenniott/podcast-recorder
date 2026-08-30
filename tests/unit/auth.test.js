import { describe, it, expect } from 'vitest'
import {
  hashPassword,
  verifyPassword,
  makeSessionToken,
  verifySessionToken,
  makeHostClaimToken,
  verifyHostClaimToken,
  getHostClaim,
  generateSlug
} from '../../src/lib/server/auth.js'

// ─── Password hashing ───────────────────────────────────────────────────────

describe('hashPassword / verifyPassword', () => {
  it('verifies a correct password', async () => {
    const hash = await hashPassword('hunter2')
    expect(await verifyPassword('hunter2', hash)).toBe(true)
  })

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('hunter2')
    expect(await verifyPassword('wrong', hash)).toBe(false)
  })

  it('produces a different hash each call (salted)', async () => {
    const a = await hashPassword('same')
    const b = await hashPassword('same')
    expect(a).not.toBe(b)
  })
})

// ─── Session tokens ─────────────────────────────────────────────────────────

describe('makeSessionToken / verifySessionToken', () => {
  const slug   = 'testslug'
  const phash  = '$2a$10$fakehashfortoken'
  const secret = 'test-secret-do-not-use-in-prod'

  it('verifies a valid token', () => {
    const token = makeSessionToken(slug, phash, secret)
    expect(verifySessionToken(token, slug, phash, secret)).toBe(true)
  })

  it('rejects a tampered token', () => {
    const token = makeSessionToken(slug, phash, secret)
    const tampered = token.slice(0, -2) + '00'
    expect(verifySessionToken(tampered, slug, phash, secret)).toBe(false)
  })

  it('rejects a token from a different slug', () => {
    const token = makeSessionToken(slug, phash, secret)
    expect(verifySessionToken(token, 'otherslug', phash, secret)).toBe(false)
  })

  it('rejects a token from a different password hash', () => {
    const token = makeSessionToken(slug, phash, secret)
    expect(verifySessionToken(token, slug, 'differenthash', secret)).toBe(false)
  })

  it('rejects a token made with a different secret', () => {
    const token = makeSessionToken(slug, phash, 'other-secret')
    expect(verifySessionToken(token, slug, phash, secret)).toBe(false)
  })

  it('rejects null / undefined inputs gracefully', () => {
    expect(verifySessionToken(null, slug, phash, secret)).toBe(false)
    expect(verifySessionToken(undefined, slug, phash, secret)).toBe(false)
    expect(verifySessionToken('', slug, phash, secret)).toBe(false)
    expect(verifySessionToken('zz', slug, phash, secret)).toBe(false)
  })

  it('uses process.env.SECRET when no secret argument is passed', () => {
    const token = makeSessionToken(slug, phash)
    expect(verifySessionToken(token, slug, phash)).toBe(true)
  })

  it('throws when SECRET is missing and no secret argument is passed', () => {
    const previous = process.env.SECRET
    delete process.env.SECRET
    try {
      expect(() => makeSessionToken(slug, phash)).toThrow('SECRET environment variable is not set')
    } finally {
      process.env.SECRET = previous
    }
  })
})

// ─── Host claim tokens ──────────────────────────────────────────────────────

describe('makeHostClaimToken / verifyHostClaimToken', () => {
  const slug   = 'testslug'
  const phash  = '$2a$10$fakehashfortoken'
  const secret = 'test-secret-do-not-use-in-prod'

  it('verifies a valid token', () => {
    const token = makeHostClaimToken(slug, phash, secret)
    expect(verifyHostClaimToken(token, slug, phash, secret)).toBe(true)
  })

  it('rejects a tampered token', () => {
    const token = makeHostClaimToken(slug, phash, secret)
    const tampered = token.slice(0, -2) + '00'
    expect(verifyHostClaimToken(tampered, slug, phash, secret)).toBe(false)
  })

  it('rejects a token from a different slug', () => {
    const token = makeHostClaimToken(slug, phash, secret)
    expect(verifyHostClaimToken(token, 'otherslug', phash, secret)).toBe(false)
  })

  it('rejects a token from a different password hash', () => {
    const token = makeHostClaimToken(slug, phash, secret)
    expect(verifyHostClaimToken(token, slug, 'differenthash', secret)).toBe(false)
  })

  it('rejects a token made with a different secret', () => {
    const token = makeHostClaimToken(slug, phash, 'other-secret')
    expect(verifyHostClaimToken(token, slug, phash, secret)).toBe(false)
  })

  it('rejects null / undefined inputs gracefully', () => {
    expect(verifyHostClaimToken(null, slug, phash, secret)).toBe(false)
    expect(verifyHostClaimToken(undefined, slug, phash, secret)).toBe(false)
    expect(verifyHostClaimToken('', slug, phash, secret)).toBe(false)
    expect(verifyHostClaimToken('zz', slug, phash, secret)).toBe(false)
  })

  it('is not interchangeable with a session token', () => {
    const session = makeSessionToken(slug, phash, secret)
    expect(verifyHostClaimToken(session, slug, phash, secret)).toBe(false)
  })

  it('uses process.env.SECRET when no secret argument is passed', () => {
    const token = makeHostClaimToken(slug, phash)
    expect(verifyHostClaimToken(token, slug, phash)).toBe(true)
  })
})

// ─── Shared host-claim check ────────────────────────────────────────────────

describe('getHostClaim', () => {
  const slug   = 'testslug'
  const phash  = '$2a$10$fakehashfortoken'
  const secret = 'test-secret-do-not-use-in-prod'
  const room   = { slug, password_hash: phash }

  function makeCookies(seed = {}) {
    const jar = new Map(Object.entries(seed))
    return { get: (name) => jar.get(name) }
  }

  it('returns true for a valid host-claim cookie matching the active room', () => {
    const token = makeHostClaimToken(slug, phash, secret)
    const cookies = makeCookies({ [`pr_host_${slug}`]: token })
    expect(getHostClaim(slug, cookies, room, secret)).toBe(true)
  })

  it('returns false when the host cookie is missing', () => {
    const cookies = makeCookies()
    expect(getHostClaim(slug, cookies, room, secret)).toBe(false)
  })

  it('returns false for an invalid/forged token', () => {
    const cookies = makeCookies({ [`pr_host_${slug}`]: 'not-a-real-token' })
    expect(getHostClaim(slug, cookies, room, secret)).toBe(false)
  })

  it('returns false for a token tampered after being issued', () => {
    const token = makeHostClaimToken(slug, phash, secret)
    const tampered = token.slice(0, -2) + '00'
    const cookies = makeCookies({ [`pr_host_${slug}`]: tampered })
    expect(getHostClaim(slug, cookies, room, secret)).toBe(false)
  })

  it('returns false when the token is valid for a different room (different password hash)', () => {
    const token = makeHostClaimToken(slug, 'a-different-password-hash', secret)
    const cookies = makeCookies({ [`pr_host_${slug}`]: token })
    expect(getHostClaim(slug, cookies, room, secret)).toBe(false)
  })

  it('returns false when the token was issued for a different slug', () => {
    const token = makeHostClaimToken('other-slug', phash, secret)
    // Cookie stored under this slug's own cookie name, but the token payload is for another slug.
    const cookies = makeCookies({ [`pr_host_${slug}`]: token })
    expect(getHostClaim(slug, cookies, room, secret)).toBe(false)
  })

  it('returns false when room is null (expired/deleted room), even with an otherwise-valid token', () => {
    const token = makeHostClaimToken(slug, phash, secret)
    const cookies = makeCookies({ [`pr_host_${slug}`]: token })
    expect(getHostClaim(slug, cookies, null, secret)).toBe(false)
  })

  it('uses process.env.SECRET when no secret argument is passed', () => {
    const previous = process.env.SECRET
    process.env.SECRET = secret
    try {
      const token = makeHostClaimToken(slug, phash, secret)
      const cookies = makeCookies({ [`pr_host_${slug}`]: token })
      expect(getHostClaim(slug, cookies, room)).toBe(true)
    } finally {
      process.env.SECRET = previous
    }
  })
})

// ─── Slug generation ────────────────────────────────────────────────────────

describe('generateSlug', () => {
  it('returns a 10-character string', () => {
    expect(generateSlug()).toHaveLength(10)
  })

  it('only contains safe characters', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateSlug()).toMatch(/^[abcdefghijkmnpqrstuvwxyz23456789]+$/)
    }
  })

  it('produces unique slugs across 500 calls', () => {
    const seen = new Set()
    for (let i = 0; i < 500; i++) seen.add(generateSlug())
    expect(seen.size).toBe(500)
  })
})
