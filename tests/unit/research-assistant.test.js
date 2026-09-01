import { describe, it, expect, beforeEach, vi } from 'vitest'
import { askResearchAssistant, ResearchAssistantError } from '../../src/lib/server/research-assistant.js'
import { serializeResearchCard } from '../../src/lib/research-card.js'

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

// A well-formed model response for the given mode — plain labeled text,
// not JSON (see research-card.js's doc comment).
function fieldAnswer(mode, overrides = {}) {
  const fields = {
    provenInTranscript: 0,
    ubiquitousKnowledge: 0,
    outputType: mode,
    contextSummary: 'the claim in question',
    mainTakeaway: 'The actual answer, stated as fact.',
    sources: 'Wikipedia',
    ...overrides
  }
  return [
    `PROVEN IN TRANSCRIPT: ${fields.provenInTranscript}`,
    `UBIQUITOUS KNOWLEDGE: ${fields.ubiquitousKnowledge}`,
    `OUTPUT TYPE: ${fields.outputType}`,
    `CONTEXT SUMMARY: ${fields.contextSummary}`,
    `MAIN TAKEAWAY: ${fields.mainTakeaway}`,
    fields.sources != null ? `SOURCES: ${fields.sources}` : null
  ]
    .filter((line) => line != null)
    .join('\n')
}

function successBody({ answer = fieldAnswer('research'), citations = [] } = {}) {
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

  it('a voice ask always sends MODE: research, and mentions the topic asked', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(successBody()))

    await askResearchAssistant(
      { kind: 'voice', query: 'the Monroe Doctrine', context: 'earlier chat about foreign policy', notes: '' },
      { fetchImpl }
    )

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body)
    const system = body.messages.find((m) => m.role === 'system').content
    const userContent = body.messages.find((m) => m.role === 'user').content
    expect(system).toMatch(/MODE: research/)
    expect(userContent).toContain('the Monroe Doctrine')
  })

  it('a voice ask with no topic still runs in research mode over the transcript window', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(successBody()))

    await askResearchAssistant(
      { kind: 'voice', query: null, context: 'Alice: so anyway that thing from the news', notes: '' },
      { fetchImpl }
    )

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body)
    const system = body.messages.find((m) => m.role === 'system').content
    const userContent = body.messages.find((m) => m.role === 'user').content
    expect(system).toMatch(/MODE: research/)
    expect(userContent).toContain('FOCUS WINDOW:')
    expect(userContent).toContain('Alice: so anyway that thing from the news')
    expect(userContent).not.toMatch(/GROUNDING:/)
  })

  it('a topic-less voice request with notes labels them GROUNDING, after FOCUS WINDOW', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(successBody()))

    await askResearchAssistant(
      {
        kind: 'voice',
        query: null,
        context: 'Ben: I think they did a cover of Jolene',
        notes: 'Ben: so Jack White\nBen: married his sister turned out not to be a sister'
      },
      { fetchImpl }
    )

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body)
    const userContent = body.messages.find((m) => m.role === 'user').content
    expect(userContent).toContain('FOCUS WINDOW:\nBen: I think they did a cover of Jolene')
    expect(userContent).toContain('GROUNDING:\nBen: so Jack White')
    expect(userContent.indexOf('FOCUS WINDOW:')).toBeLessThan(userContent.indexOf('GROUNDING:'))
  })

  it('includes notes for grounding when present alongside an explicit query', async () => {
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
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(successBody({ answer: fieldAnswer(actionId) })))

    await askResearchAssistant({ kind: 'quickAction', actionId, text: 'Some tab text about tariffs.' }, { fetchImpl })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body)
    expect(body.plugins).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'web' })]))
    const system = body.messages.find((m) => m.role === 'system').content
    const userContent = body.messages.find((m) => m.role === 'user').content
    expect(system).toContain(`MODE: ${actionId}`)
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

  it('returns the parsed card and the web-search citations for a well-formed, on-mode answer', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse(
        successBody({
          answer: fieldAnswer('research', {
            contextSummary: 'when the Monroe Doctrine was issued',
            mainTakeaway: 'The Monroe Doctrine was a US policy stance from 1823.'
          }),
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

    const card = JSON.parse(result.answer)
    expect(card.mainTakeaway).toBe('The Monroe Doctrine was a US policy stance from 1823.')
    expect(card.outputType).toBe('research')
    expect(result.citations).toEqual([
      { url: 'https://example.com/monroe', title: 'Monroe Doctrine — Britannica' },
      { url: 'https://example.com/monroe2', title: 'Monroe Doctrine — Wikipedia' }
    ])
  })

  it('discards the answer and citations when the model returns nothing (no claim survived selection)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(successBody({ answer: 'nothing useful here, no fields at all' })))

    const result = await askResearchAssistant({ kind: 'voice', query: 'x', context: '', notes: '' }, { fetchImpl })

    expect(result).toEqual({ answer: serializeResearchCard(null), citations: [] })
  })

  it('suppresses (score-threshold guard) an answer already proven in the transcript, even with citations present', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse(
        successBody({
          answer: fieldAnswer('research', { provenInTranscript: 95 }),
          citations: [{ url: 'https://example.com/x', title: 'X' }]
        })
      )
    )

    const result = await askResearchAssistant({ kind: 'voice', query: 'x', context: '', notes: '' }, { fetchImpl })

    expect(result).toEqual({ answer: serializeResearchCard(null), citations: [] })
  })

  it('suppresses (score-threshold guard) an answer that is ubiquitous knowledge', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse(successBody({ answer: fieldAnswer('research', { ubiquitousKnowledge: 90 }) }))
    )

    const result = await askResearchAssistant({ kind: 'voice', query: 'x', context: '', notes: '' }, { fetchImpl })

    expect(result).toEqual({ answer: serializeResearchCard(null), citations: [] })
  })

  it('discards (mode-match guard) an answer whose OUTPUT TYPE does not match the requested mode', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse(successBody({ answer: fieldAnswer('factCheck') })) // requested mode is 'research' below
    )

    const result = await askResearchAssistant({ kind: 'voice', query: 'x', context: '', notes: '' }, { fetchImpl })

    expect(result).toEqual({ answer: serializeResearchCard(null), citations: [] })
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
