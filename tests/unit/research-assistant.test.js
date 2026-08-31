import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { askResearchAssistant, ResearchAssistantError } from '../../src/lib/server/research-assistant.js'

beforeEach(() => {
  delete process.env.OPENROUTER_API_KEY
  delete process.env.OPENROUTER_MODEL
})

describe('askResearchAssistant — not configured', () => {
  it('throws a NOT_CONFIGURED error when no API key is set', async () => {
    const fetchImpl = vi.fn()

    await expect(
      askResearchAssistant({ kind: 'voice', query: 'the Monroe Doctrine', context: '', notes: '' }, { fetchImpl })
    ).rejects.toMatchObject({ code: 'NOT_CONFIGURED' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('the thrown error is a ResearchAssistantError instance callers can branch on without string-matching', async () => {
    await expect(
      askResearchAssistant({ kind: 'voice', query: 'x', context: '', notes: '' }, { fetchImpl: vi.fn() })
    ).rejects.toBeInstanceOf(ResearchAssistantError)
  })
})

function okResponse(body) {
  return { ok: true, status: 200, json: async () => body }
}

function successBody({ answer = 'Some answer.', citations = [] } = {}) {
  return {
    choices: [
      {
        message: {
          content: answer,
          annotations: citations.map((c) => ({ type: 'url_citation', url_citation: c }))
        }
      }
    ]
  }
}

describe('askResearchAssistant — building the OpenRouter request', () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = 'test-api-key'
  })

  it('calls OpenRouter with the configured model, the API key as a bearer token, and the web-search plugin enabled', async () => {
    process.env.OPENROUTER_MODEL = 'openai/gpt-4o-mini'
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(successBody()))

    await askResearchAssistant(
      { kind: 'voice', query: 'the Monroe Doctrine', context: '', notes: '' },
      { fetchImpl }
    )

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(init.headers.Authorization).toBe('Bearer test-api-key')
    expect(init.headers['content-type']).toMatch(/application\/json/)

    const body = JSON.parse(init.body)
    expect(body.model).toBe('openai/gpt-4o-mini')
    expect(body.plugins).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'web' })]))
  })

  it('defaults to a cheap model when OPENROUTER_MODEL is not set', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(successBody()))

    await askResearchAssistant({ kind: 'voice', query: 'topic', context: '', notes: '' }, { fetchImpl })

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body)
    expect(typeof body.model).toBe('string')
    expect(body.model.length).toBeGreaterThan(0)
  })

  it('a voice request with an explicit topic mentions that topic in the prompt', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(successBody()))

    await askResearchAssistant(
      { kind: 'voice', query: 'the Monroe Doctrine', context: 'earlier chat about foreign policy', notes: '' },
      { fetchImpl }
    )

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body)
    const userContent = body.messages.find((m) => m.role === 'user').content
    expect(userContent).toContain('the Monroe Doctrine')
  })

  it('a voice request with no topic falls back to conversation context instead of naming a topic', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(successBody()))

    await askResearchAssistant(
      { kind: 'voice', query: null, context: 'Alice: so anyway that thing from the news', notes: '' },
      { fetchImpl }
    )

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body)
    const userContent = body.messages.find((m) => m.role === 'user').content
    expect(userContent).toContain('Alice: so anyway that thing from the news')
  })

  it('includes the active tab\'s notes for grounding when present', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(successBody()))

    await askResearchAssistant(
      { kind: 'voice', query: 'topic', context: '', notes: 'Notes: the guest mentioned tariffs earlier.' },
      { fetchImpl }
    )

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body)
    const userContent = body.messages.find((m) => m.role === 'user').content
    expect(userContent).toContain('Notes: the guest mentioned tariffs earlier.')
  })
})

describe('askResearchAssistant — Quick Actions', () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = 'test-api-key'
  })

  const QUICK_ACTIONS = ['define', 'keyFacts', 'factCheck', 'findExamples', 'analyze']

  it.each(QUICK_ACTIONS)('builds a well-formed request for the %s Quick Action, including the tab text', async (actionId) => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(successBody()))

    await askResearchAssistant({ kind: 'quickAction', actionId, text: 'Some tab text about tariffs.' }, { fetchImpl })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body)
    expect(body.plugins).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'web' })]))
    const userContent = body.messages.find((m) => m.role === 'user').content
    expect(userContent).toContain('Some tab text about tariffs.')
  })

  it('rejects an unknown Quick Action id', async () => {
    await expect(
      askResearchAssistant({ kind: 'quickAction', actionId: 'bogus', text: 'text' }, { fetchImpl: vi.fn() })
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })
})

describe('askResearchAssistant — response shaping', () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = 'test-api-key'
  })

  it('returns the answer text and the web-search citations, discarding nothing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse(
        successBody({
          answer: 'The Monroe Doctrine was a US policy stance from 1823.',
          citations: [
            { url: 'https://example.com/monroe', title: 'Monroe Doctrine — Britannica' },
            { url: 'https://example.com/monroe2', title: 'Monroe Doctrine — Wikipedia' }
          ]
        })
      )
    )

    const result = await askResearchAssistant(
      { kind: 'voice', query: 'the Monroe Doctrine', context: '', notes: '' },
      { fetchImpl }
    )

    expect(result).toEqual({
      answer: 'The Monroe Doctrine was a US policy stance from 1823.',
      citations: [
        { url: 'https://example.com/monroe', title: 'Monroe Doctrine — Britannica' },
        { url: 'https://example.com/monroe2', title: 'Monroe Doctrine — Wikipedia' }
      ]
    })
  })

  it('returns an empty citations array when web search returned no sources', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(successBody({ answer: 'Just an answer.', citations: [] })))

    const result = await askResearchAssistant({ kind: 'voice', query: 'x', context: '', notes: '' }, { fetchImpl })

    expect(result).toEqual({ answer: 'Just an answer.', citations: [] })
  })

  it('returns an empty citations array when the response omits annotations entirely', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({ choices: [{ message: { content: 'An answer with no annotations field at all.' } }] })
    )

    const result = await askResearchAssistant({ kind: 'voice', query: 'x', context: '', notes: '' }, { fetchImpl })

    expect(result).toEqual({ answer: 'An answer with no annotations field at all.', citations: [] })
  })
})

describe('askResearchAssistant — error kinds', () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = 'test-api-key'
  })

  it('throws UPSTREAM_ERROR on a non-2xx OpenRouter response, without leaking the API key', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'internal server error'
    })

    let thrown
    try {
      await askResearchAssistant({ kind: 'voice', query: 'x', context: '', notes: '' }, { fetchImpl })
    } catch (e) {
      thrown = e
    }

    expect(thrown).toMatchObject({ code: 'UPSTREAM_ERROR' })
    expect(thrown.message).not.toContain('test-api-key')
    expect(String(thrown.stack)).not.toContain('test-api-key')
  })

  it('throws EMPTY_ANSWER when OpenRouter returns no usable answer text', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(successBody({ answer: '' })))

    await expect(
      askResearchAssistant({ kind: 'voice', query: 'x', context: '', notes: '' }, { fetchImpl })
    ).rejects.toMatchObject({ code: 'EMPTY_ANSWER' })
  })

  it('throws EMPTY_ANSWER when the response has no choices at all', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ choices: [] }))

    await expect(
      askResearchAssistant({ kind: 'voice', query: 'x', context: '', notes: '' }, { fetchImpl })
    ).rejects.toMatchObject({ code: 'EMPTY_ANSWER' })
  })

  it('throws UPSTREAM_ERROR when the fetch itself rejects with a plain network error (not a timeout)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'))

    await expect(
      askResearchAssistant({ kind: 'voice', query: 'x', context: '', notes: '' }, { fetchImpl })
    ).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' })
  })

  it('rejects a request with an unrecognized kind', async () => {
    await expect(
      askResearchAssistant({ kind: 'bogus' }, { fetchImpl: vi.fn() })
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('throws TIMEOUT when the request takes too long', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = vi.fn((url, init) => {
        return new Promise((resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          })
        })
      })

      const promise = askResearchAssistant({ kind: 'voice', query: 'x', context: '', notes: '' }, { fetchImpl })
      const assertion = expect(promise).rejects.toMatchObject({ code: 'TIMEOUT' })
      await vi.runAllTimersAsync()
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})
