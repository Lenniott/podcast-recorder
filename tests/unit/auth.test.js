import { describe, it, expect } from 'vitest'
import {
  hashPassword,
  verifyPassword,
  makeSessionToken,
  verifySessionToken,
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
