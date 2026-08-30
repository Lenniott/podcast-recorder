import { createHmac } from 'crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const SECRET = 'test-secret-do-not-use-in-prod'
const SITE_PASSWORD = 'gate-pass'

function siteToken(password = SITE_PASSWORD) {
  return createHmac('sha256', SECRET).update('site:' + password).digest('hex')
}

function makeEvent({
  pathname = '/',
  search = '',
  method = 'GET',
  headers = {},
  cookie
} = {}) {
  const url = new URL(`http://test${pathname}${search}`)
  return {
    url,
    request: { method, headers: new Headers(headers) },
    cookies: { get: (name) => (name === 'pr_site_auth' ? cookie : undefined) }
  }
}

async function loadHandle() {
  const { handle } = await import('../../src/hooks.server.js')
  return handle
}

describe('hooks.server handle', () => {
  beforeEach(() => {
    vi.resetModules()
    delete process.env.SITE_PASSWORD
    delete process.env.HTTPS
    delete process.env.FORCE_HTTPS
    process.env.SECRET = SECRET
    process.env.MAX_POSTS_PER_MIN = '20'
    process.env.MAX_AUTH_POSTS_PER_MIN = '10'
  })

  afterEach(() => {
    vi.useRealTimers()
    process.env.SECRET = SECRET
  })

  it('skips auth and rate limits for /_app assets', async () => {
    process.env.SITE_PASSWORD = SITE_PASSWORD
    process.env.MAX_POSTS_PER_MIN = '1'
    const handle = await loadHandle()
    const resolve = vi.fn(async (event) => ({ ok: true, event }))
    const event = makeEvent({ pathname: '/_app/chunk.js', method: 'POST' })
    const result = await handle({ event, resolve })
    expect(resolve).toHaveBeenCalledOnce()
    expect(result).toEqual({ ok: true, event })
  })

  it('skips auth and rate limits for /favicon.ico', async () => {
    process.env.SITE_PASSWORD = SITE_PASSWORD
    const handle = await loadHandle()
    const resolve = vi.fn(async () => 'favicon')
    const result = await handle({
      event: makeEvent({ pathname: '/favicon.ico' }),
      resolve
    })
    expect(resolve).toHaveBeenCalledOnce()
    expect(result).toBe('favicon')
  })

  it('throws 429 after the general POST limit for a stable IP', async () => {
    process.env.MAX_POSTS_PER_MIN = '2'
    const handle = await loadHandle()
    const resolve = vi.fn(async () => 'ok')
    const headers = { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }
    await handle({ event: makeEvent({ method: 'POST', headers }), resolve })
    await handle({ event: makeEvent({ method: 'POST', headers }), resolve })
    await expect(
      handle({ event: makeEvent({ method: 'POST', headers }), resolve })
    ).rejects.toMatchObject({
      status: 429,
      body: { message: 'Too many requests — slow down and try again in a minute.' }
    })
  })

  it('does not rate-limit authenticated server-copy upload POSTs', async () => {
    process.env.MAX_POSTS_PER_MIN = '2'
    const handle = await loadHandle()
    const resolve = vi.fn(async () => 'ok')
    const headers = { 'x-forwarded-for': '203.0.113.44, 10.0.0.1' }
    const uploadRequests = [
      { pathname: '/rec/abc/server-copy/session' },
      ...Array.from({ length: 5 }, (_, i) => ({
        pathname: '/rec/abc/server-copy/chunks',
        search: `?clientId=client123&offset=${i}`
      })),
      { pathname: '/rec/abc/server-copy/finalize' }
    ]

    for (const { pathname, search = '' } of uploadRequests) {
      const result = await handle({
        event: makeEvent({
          pathname,
          search,
          method: 'POST',
          headers
        }),
        resolve
      })
      expect(result).toBe('ok')
    }
  })

  it('uses the auth POST bucket for SvelteKit ?/enter actions', async () => {
    process.env.MAX_AUTH_POSTS_PER_MIN = '2'
    process.env.MAX_POSTS_PER_MIN = '100'
    const handle = await loadHandle()
    const resolve = vi.fn(async () => 'ok')
    const headers = { 'x-real-ip': '198.51.100.4' }
    const enter = () =>
      handle({
        event: makeEvent({
          pathname: '/rec/abc',
          search: '?/enter',
          method: 'POST',
          headers
        }),
        resolve
      })

    await enter()
    await enter()
    await expect(enter()).rejects.toMatchObject({ status: 429 })

    const general = await handle({
      event: makeEvent({ pathname: '/', method: 'POST', headers }),
      resolve
    })
    expect(general).toBe('ok')
  })

  it('still uses the auth bucket when other query params sit before the action', async () => {
    process.env.MAX_AUTH_POSTS_PER_MIN = '1'
    process.env.MAX_POSTS_PER_MIN = '100'
    const handle = await loadHandle()
    const resolve = vi.fn(async () => 'ok')
    const headers = { 'x-real-ip': '198.51.100.20' }
    await handle({
      event: makeEvent({
        pathname: '/rec/abc',
        search: '?expired=1&/enter',
        method: 'POST',
        headers
      }),
      resolve
    })
    await expect(
      handle({
        event: makeEvent({
          pathname: '/rec/abc',
          search: '?utm=x&/enter',
          method: 'POST',
          headers
        }),
        resolve
      })
    ).rejects.toMatchObject({ status: 429 })
  })

  it('does not treat a non-slash query key as a named action', async () => {
    process.env.MAX_AUTH_POSTS_PER_MIN = '1'
    process.env.MAX_POSTS_PER_MIN = '100'
    const handle = await loadHandle()
    const resolve = vi.fn(async () => 'ok')
    const headers = { 'x-real-ip': '198.51.100.21' }
    await handle({
      event: makeEvent({ search: '?enter=1', method: 'POST', headers }),
      resolve
    })
    const result = await handle({
      event: makeEvent({ search: '?enter=1', method: 'POST', headers }),
      resolve
    })
    expect(result).toBe('ok')
  })

  it('prunes stale rate-limit entries and keeps ones still in the window', async () => {
    vi.useFakeTimers()
    process.env.MAX_POSTS_PER_MIN = '2'
    const handle = await loadHandle()
    const resolve = vi.fn(async () => 'ok')
    const staleHeaders = { 'x-real-ip': '203.0.113.10' }
    const freshHeaders = { 'x-real-ip': '203.0.113.11' }

    await handle({
      event: makeEvent({ method: 'POST', headers: staleHeaders }),
      resolve
    })
    await vi.advanceTimersByTimeAsync(90_000)
    await handle({
      event: makeEvent({ method: 'POST', headers: freshHeaders }),
      resolve
    })
    // First interval tick: stale IP is outside WINDOW_MS and dropped;
    // fresh IP is kept.
    await vi.advanceTimersByTimeAsync(30_000)

    await handle({
      event: makeEvent({ method: 'POST', headers: staleHeaders }),
      resolve
    })
    await handle({
      event: makeEvent({ method: 'POST', headers: staleHeaders }),
      resolve
    })
    await expect(
      handle({
        event: makeEvent({ method: 'POST', headers: staleHeaders }),
        resolve
      })
    ).rejects.toMatchObject({ status: 429 })

    await handle({
      event: makeEvent({ method: 'POST', headers: freshHeaders }),
      resolve
    })
    await expect(
      handle({
        event: makeEvent({ method: 'POST', headers: freshHeaders }),
        resolve
      })
    ).rejects.toMatchObject({ status: 429 })
  })

  it('uses the auth POST bucket for ?/site_enter', async () => {
    process.env.MAX_AUTH_POSTS_PER_MIN = '1'
    process.env.MAX_POSTS_PER_MIN = '100'
    const handle = await loadHandle()
    const resolve = vi.fn(async () => 'ok')
    const headers = { 'x-real-ip': '192.0.2.8' }
    await handle({
      event: makeEvent({ search: '?/site_enter', method: 'POST', headers }),
      resolve
    })
    await expect(
      handle({
        event: makeEvent({ search: '?/site_enter', method: 'POST', headers }),
        resolve
      })
    ).rejects.toMatchObject({ status: 429 })
  })

  describe('SITE_PASSWORD gate', () => {
    beforeEach(() => {
      process.env.SITE_PASSWORD = SITE_PASSWORD
    })

    it('lets unauthenticated /rec pages through', async () => {
      const handle = await loadHandle()
      const resolve = vi.fn(async () => 'room')
      const result = await handle({
        event: makeEvent({ pathname: '/rec/some-slug' }),
        resolve
      })
      expect(result).toBe('room')
    })

    it('lets unauthenticated /ws through', async () => {
      const handle = await loadHandle()
      const resolve = vi.fn(async () => 'ws')
      const result = await handle({
        event: makeEvent({ pathname: '/ws' }),
        resolve
      })
      expect(result).toBe('ws')
    })

    it('lets unauthenticated / through so the site password can be entered', async () => {
      const handle = await loadHandle()
      const resolve = vi.fn(async () => 'home')
      const result = await handle({ event: makeEvent({ pathname: '/' }), resolve })
      expect(result).toBe('home')
    })

    it('redirects other unauthenticated paths to /', async () => {
      const handle = await loadHandle()
      await expect(
        handle({
          event: makeEvent({ pathname: '/somewhere' }),
          resolve: vi.fn()
        })
      ).rejects.toMatchObject({ status: 303, location: '/' })
    })

    it('passes through with a valid pr_site_auth cookie', async () => {
      const handle = await loadHandle()
      const resolve = vi.fn(async () => 'ok')
      const result = await handle({
        event: makeEvent({ pathname: '/somewhere', cookie: siteToken() }),
        resolve
      })
      expect(result).toBe('ok')
    })

    it('rejects a malformed site cookie', async () => {
      const handle = await loadHandle()
      await expect(
        handle({
          event: makeEvent({ pathname: '/somewhere', cookie: 'not-hex' }),
          resolve: vi.fn()
        })
      ).rejects.toMatchObject({ status: 303, location: '/' })
    })
  })
})
