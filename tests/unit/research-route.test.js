import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../src/lib/server/research-assistant.js', async () => {
  class ResearchAssistantError extends Error {
    constructor(code, message) {
      super(message)
      this.name = 'ResearchAssistantError'
      this.code = code
    }
  }
  return {
    askResearchAssistant: vi.fn(),
    ResearchAssistantError
  }
})

import { hashPassword, makeSessionToken } from '../../src/lib/server/auth.js'
import db, { createRoom, _resetDb, setResearchPrompt } from '../../src/lib/server/db.js'
import { askResearchAssistant } from '../../src/lib/server/research-assistant.js'

const SECRET = 'test-secret-do-not-use-in-prod'
const SLUG = 'roomslug01'
const ROOM_PASS = 'room-pass'

function makeCookies(seed = {}) {
  const jar = new Map(Object.entries(seed))
  return { get: (name) => jar.get(name) }
}

async function loadRoute() {
  return import('../../src/routes/rec/[slug]/research/+server.js')
}

async function seedRoom({ createdAt, guestAiAllowed = false } = {}) {
  const passwordHash = await hashPassword(ROOM_PASS)
  createRoom({ slug: SLUG, name: 'Test Episode', passwordHash, guestAiAllowed })
  if (createdAt != null) {
    db.getDb().prepare('UPDATE rooms SET created_at = ? WHERE slug = ?').run(createdAt, SLUG)
  }
  return passwordHash
}

async function authedCookies(opts) {
  const passwordHash = await seedRoom(opts)
  const token = makeSessionToken(SLUG, passwordHash, SECRET)
  return makeCookies({ [`pr_auth_${SLUG}`]: token })
}

const fakeFetch = () => {}

beforeEach(() => {
  process.env.DB_PATH = ':memory:'
  process.env.SECRET = SECRET
  _resetDb()
  askResearchAssistant.mockReset()
})

describe('POST /rec/[slug]/research — auth gating', () => {
  it('rejects (401) a request without a valid room session cookie', async () => {
    await seedRoom()
    const { POST } = await loadRoute()

    const res = await POST({
      params: { slug: SLUG },
      cookies: makeCookies(),
      fetch: fakeFetch,
      request: { json: async () => ({ kind: 'voice', query: 'hello', context: '', notes: '' }) }
    })

    expect(res.status).toBe(401)
    expect(askResearchAssistant).not.toHaveBeenCalled()
  })

  it('rejects (410) a request for an unknown/expired room', async () => {
    await seedRoom({ createdAt: Date.now() - 13 * 60 * 60 * 1000 })
    process.env.ROOM_MAX_AGE_HOURS = '12'
    const { POST } = await loadRoute()

    const res = await POST({
      params: { slug: SLUG },
      cookies: makeCookies(),
      fetch: fakeFetch,
      request: { json: async () => ({ kind: 'voice', query: 'hello', context: '', notes: '' }) }
    })

    expect(res.status).toBe(410)
    expect(askResearchAssistant).not.toHaveBeenCalled()
  })
})

describe('POST /rec/[slug]/research — success', () => {
  it('calls askResearchAssistant with the request body and event.fetch, returning its answer/citations', async () => {
    const cookies = await authedCookies()
    const { POST } = await loadRoute()
    askResearchAssistant.mockResolvedValue({ answer: 'The answer.', citations: [{ url: 'https://x.test', title: 'X' }] })

    const body = { kind: 'turnAction', actionId: 'definition', focus: 'Host: hello', grounding: '' }
    const res = await POST({
      params: { slug: SLUG },
      cookies,
      fetch: fakeFetch,
      request: { json: async () => body }
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ answer: 'The answer.', citations: [{ url: 'https://x.test', title: 'X' }] })
    expect(askResearchAssistant).toHaveBeenCalledTimes(1)
    const [passedRequest, options] = askResearchAssistant.mock.calls[0]
    expect(passedRequest).toEqual(body)
    expect(options.fetchImpl).toBe(fakeFetch)
  })
})

describe('POST /rec/[slug]/research — Custom gated by Guest Research Access', () => {
  it('rejects (403) Custom from a non-host when Guest Research Access is off', async () => {
    setResearchPrompt('Summarise the notes.')
    const cookies = await authedCookies() // guestAiAllowed defaults to false
    const { POST } = await loadRoute()

    const res = await POST({
      params: { slug: SLUG },
      cookies,
      fetch: fakeFetch,
      request: { json: async () => ({ kind: 'custom', text: 'some notes' }) }
    })

    expect(res.status).toBe(403)
    expect(askResearchAssistant).not.toHaveBeenCalled()
  })

  it('allows Custom from a non-host when the room has Guest Research Access on, sending the stored Research Prompt', async () => {
    setResearchPrompt('Summarise the notes.')
    const cookies = await authedCookies({ guestAiAllowed: true })
    const { POST } = await loadRoute()
    askResearchAssistant.mockResolvedValue({ answer: 'ok', citations: [] })

    const res = await POST({
      params: { slug: SLUG },
      cookies,
      fetch: fakeFetch,
      request: { json: async () => ({ kind: 'custom', text: 'some notes' }) }
    })

    expect(res.status).toBe(200)
    const [passedRequest] = askResearchAssistant.mock.calls[0]
    expect(passedRequest.instruction).toBe('Summarise the notes.')
  })
})

describe('POST /rec/[slug]/research — request validation', () => {
  it.each([
    ['missing kind', {}],
    ['unknown kind', { kind: 'bogus' }],
    ['turnAction with an unknown actionId', { kind: 'turnAction', actionId: 'bogus', focus: 'Host: hi', grounding: '' }],
    ['turnAction with empty focus', { kind: 'turnAction', actionId: 'facts', focus: '', grounding: '' }],
    ['turnAction with oversized focus', { kind: 'turnAction', actionId: 'facts', focus: 'x'.repeat(20_001), grounding: '' }],
    ['voice with an oversized query', { kind: 'voice', query: 'x'.repeat(501), context: '', notes: '' }],
    ['voice with a non-string context', { kind: 'voice', query: 'x', context: 42, notes: '' }],
    ['voice with an oversized notes field', { kind: 'voice', query: 'x', context: '', notes: 'x'.repeat(20_001) }],
    ['voice with a non-string currentTab', { kind: 'voice', query: 'x', context: '', notes: '', currentTab: 42 }],
    ['voice with an oversized transcript', { kind: 'voice', query: 'x', context: '', notes: '', transcript: 'x'.repeat(20_001) }]
  ])('rejects (400) a request body: %s', async (_label, body) => {
    const cookies = await authedCookies()
    const { POST } = await loadRoute()

    const res = await POST({ params: { slug: SLUG }, cookies, fetch: fakeFetch, request: { json: async () => body } })

    expect(res.status).toBe(400)
    expect(askResearchAssistant).not.toHaveBeenCalled()
  })

  it('rejects (400) an unparseable JSON body without throwing', async () => {
    const cookies = await authedCookies()
    const { POST } = await loadRoute()

    const res = await POST({
      params: { slug: SLUG },
      cookies,
      fetch: fakeFetch,
      request: { json: async () => { throw new SyntaxError('bad json') } }
    })

    expect(res.status).toBe(400)
  })

  it('accepts a well-formed voice request with no explicit topic', async () => {
    const cookies = await authedCookies()
    const { POST } = await loadRoute()
    askResearchAssistant.mockResolvedValue({ answer: 'ok', citations: [] })

    const res = await POST({
      params: { slug: SLUG },
      cookies,
      fetch: fakeFetch,
      request: { json: async () => ({ kind: 'voice', query: null, context: 'recent chat', notes: 'tab notes' }) }
    })

    expect(res.status).toBe(200)
  })
})

describe('POST /rec/[slug]/research — error mapping', () => {
  it.each([
    ['NOT_CONFIGURED', 500],
    ['TIMEOUT', 504],
    ['UPSTREAM_ERROR', 502],
    ['EMPTY_ANSWER', 502]
  ])('maps a %s Research Assistant Client error to HTTP %i without leaking anything sensitive', async (code, status) => {
    const cookies = await authedCookies()
    const { POST } = await loadRoute()
    const { ResearchAssistantError } = await import('../../src/lib/server/research-assistant.js')
    askResearchAssistant.mockRejectedValue(new ResearchAssistantError(code, `${code} happened, key=super-secret-key`))

    const res = await POST({
      params: { slug: SLUG },
      cookies,
      fetch: fakeFetch,
      request: { json: async () => ({ kind: 'voice', query: 'hi', context: '', notes: '' }) }
    })

    expect(res.status).toBe(status)
    const bodyText = JSON.stringify(await res.json())
    expect(bodyText).not.toContain('super-secret-key')
  })

  it('never throws an unhandled exception for a completely unexpected Client failure — maps to 500', async () => {
    const cookies = await authedCookies()
    const { POST } = await loadRoute()
    askResearchAssistant.mockRejectedValue(new Error('something we did not anticipate'))

    const res = await POST({
      params: { slug: SLUG },
      cookies,
      fetch: fakeFetch,
      request: { json: async () => ({ kind: 'voice', query: 'hi', context: '', notes: '' }) }
    })

    expect(res.status).toBe(500)
  })

  it('falls back to 500 for a ResearchAssistantError code the route does not recognize', async () => {
    const cookies = await authedCookies()
    const { POST } = await loadRoute()
    const { ResearchAssistantError } = await import('../../src/lib/server/research-assistant.js')
    askResearchAssistant.mockRejectedValue(new ResearchAssistantError('SOME_FUTURE_CODE', 'unrecognized'))

    const res = await POST({
      params: { slug: SLUG },
      cookies,
      fetch: fakeFetch,
      request: { json: async () => ({ kind: 'voice', query: 'hi', context: '', notes: '' }) }
    })

    expect(res.status).toBe(500)
  })
})
