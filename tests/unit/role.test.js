import { describe, it, expect } from 'vitest'
import { resolveRole, SITE_COOKIE, FRIEND_COOKIE } from '../../src/lib/server/role.js'
import { makePasswordToken } from '../../src/lib/server/auth.js'

const SECRET = 'test-secret-do-not-use-in-prod'
const SITE_PASSWORD = 'host-pass'
const FRIEND_PASSWORD = 'friend-pass'

function makeCookies(seed = {}) {
  const jar = new Map(Object.entries(seed))
  return { get: (name) => jar.get(name) }
}

function siteToken(password = SITE_PASSWORD) {
  return makePasswordToken('site', password, SECRET)
}

function friendToken(password = FRIEND_PASSWORD) {
  return makePasswordToken('friend', password, SECRET)
}

describe('resolveRole — single source of truth for "what role does this request have"', () => {
  it('resolves "host" unconditionally when SITE_PASSWORD is unset (today\'s open-access policy)', () => {
    const env = { SECRET }
    expect(resolveRole(makeCookies(), env)).toBe('host')
    // Even a garbage/no cookie at all — open access means open access.
    expect(resolveRole(makeCookies({ [SITE_COOKIE]: 'garbage' }), env)).toBe('host')
  })

  it('resolves "host" with a valid site cookie', () => {
    const env = { SECRET, SITE_PASSWORD }
    const cookies = makeCookies({ [SITE_COOKIE]: siteToken() })
    expect(resolveRole(cookies, env)).toBe('host')
  })

  it('resolves null when SITE_PASSWORD is set, there is no site cookie, and FRIEND_PASSWORD is unset', () => {
    const env = { SECRET, SITE_PASSWORD }
    expect(resolveRole(makeCookies(), env)).toBeNull()
  })

  it('resolves "friend" with a valid friend cookie when FRIEND_PASSWORD is configured', () => {
    const env = { SECRET, SITE_PASSWORD, FRIEND_PASSWORD }
    const cookies = makeCookies({ [FRIEND_COOKIE]: friendToken() })
    expect(resolveRole(cookies, env)).toBe('friend')
  })

  it('a Friend cookie never satisfies the Host gate and vice versa (cross-role isolation)', () => {
    const env = { SECRET, SITE_PASSWORD, FRIEND_PASSWORD }
    // Friend's own valid token placed in the site cookie slot
    const cookiesFriendInSiteSlot = makeCookies({ [SITE_COOKIE]: friendToken() })
    expect(resolveRole(cookiesFriendInSiteSlot, env)).toBeNull()
    // Host's own valid token placed in the friend cookie slot
    const cookiesHostInFriendSlot = makeCookies({ [FRIEND_COOKIE]: siteToken() })
    expect(resolveRole(cookiesHostInFriendSlot, env)).toBeNull()
  })

  it('an unset FRIEND_PASSWORD disables the Friend role entirely, even with a token that would otherwise verify', () => {
    const env = { SECRET, SITE_PASSWORD } // no FRIEND_PASSWORD
    // Forge a token as if FRIEND_PASSWORD were '' — still must not grant 'friend'.
    const cookies = makeCookies({ [FRIEND_COOKIE]: makePasswordToken('friend', '', SECRET) })
    expect(resolveRole(cookies, env)).toBeNull()
  })

  it('rejects a garbage/malformed cookie on either slot without throwing', () => {
    const env = { SECRET, SITE_PASSWORD, FRIEND_PASSWORD }
    expect(resolveRole(makeCookies({ [SITE_COOKIE]: 'not-hex' }), env)).toBeNull()
    expect(resolveRole(makeCookies({ [FRIEND_COOKIE]: 'not-hex' }), env)).toBeNull()
  })

  it('rejects an expired/wrong-password token on either slot', () => {
    const env = { SECRET, SITE_PASSWORD, FRIEND_PASSWORD }
    expect(resolveRole(makeCookies({ [SITE_COOKIE]: siteToken('wrong') }), env)).toBeNull()
    expect(resolveRole(makeCookies({ [FRIEND_COOKIE]: friendToken('wrong') }), env)).toBeNull()
  })

  it('prefers "host" when both a valid site cookie and a valid friend cookie are present', () => {
    const env = { SECRET, SITE_PASSWORD, FRIEND_PASSWORD }
    const cookies = makeCookies({ [SITE_COOKIE]: siteToken(), [FRIEND_COOKIE]: friendToken() })
    expect(resolveRole(cookies, env)).toBe('host')
  })

  it('resolves null with no cookies at all when both passwords are configured', () => {
    const env = { SECRET, SITE_PASSWORD, FRIEND_PASSWORD }
    expect(resolveRole(makeCookies(), env)).toBeNull()
  })

  it('defaults to process.env when no env argument is passed', () => {
    process.env.SECRET = SECRET
    delete process.env.SITE_PASSWORD
    expect(resolveRole(makeCookies())).toBe('host')
    delete process.env.SECRET
  })
})
