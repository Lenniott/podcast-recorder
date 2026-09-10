import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  askResearchAssistant,
  applyPlaceholders,
  buildCustomPromptRequest,
  referencedPlaceholders,
  latestTranscriptWindow,
  LATEST_TRANSCRIPT_WORD_LIMIT,
  PLACEHOLDER_NAMES,
  ResearchAssistantError
} from '../../src/lib/server/research-assistant.js'
import { PLACEHOLDER_HELP } from '../../src/lib/home/custom-prompts.js'
import { appendResearchEvalLog } from '../../src/lib/server/research-eval-log.js'
import { recordResearchUsage } from '../../src/lib/server/db.js'

vi.mock('../../src/lib/server/research-eval-log.js', () => ({
  appendResearchEvalLog: vi.fn()
}))

// Usage recording (see ADR-0007) is a db.js side effect research-assistant.js
// triggers on every call — mocked here so these tests never touch a real
// SQLite file, the same way the Eval Log is mocked above.
vi.mock('../../src/lib/server/db.js', () => ({
  recordResearchUsage: vi.fn()
}))

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
    mainTakeaway: 'The actual answer, stated as fact.',
    ...overrides
  }
  return [
    `PROVEN IN TRANSCRIPT: ${fields.provenInTranscript}`,
    `UBIQUITOUS KNOWLEDGE: ${fields.ubiquitousKnowledge}`,
    `OUTPUT TYPE: ${fields.outputType}`,
    `MAIN TAKEAWAY: ${fields.mainTakeaway}`
  ]
    .filter((line) => line != null)
    .join('\n')
}

function successBody({ answer = fieldAnswer('ask'), citations = [] } = {}) {
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

  it('a typed Ask sends the question as the whole request, with no system prompt', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({ choices: [{ message: { content: 'plain answer', annotations: [] } }] })
    )

    await askResearchAssistant(
      { kind: 'voice', query: 'the Monroe Doctrine', context: 'earlier chat about foreign policy', notes: '' },
      { fetchImpl }
    )

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body)
    expect(body.messages.some((m) => m.role === 'system')).toBe(false)
    expect(body.response_format).toBeUndefined()
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: 'the Monroe Doctrine\n\nFOCUS TURN:\nearlier chat about foreign policy'
      }
    ])
  })

  it('a topic-less voice request still sends FOCUS TURN as the user message, with no system prompt', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({ choices: [{ message: { content: 'plain answer', annotations: [] } }] })
    )

    await askResearchAssistant(
      { kind: 'voice', query: null, context: 'Alice: so anyway that thing from the news', notes: '' },
      { fetchImpl }
    )

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body)
    expect(body.messages.some((m) => m.role === 'system')).toBe(false)
    const userContent = body.messages.find((m) => m.role === 'user').content
    expect(userContent).toContain('FOCUS TURN:')
    expect(userContent).toContain('Alice: so anyway that thing from the news')
    expect(userContent).not.toMatch(/GROUNDING:/)
  })

  it('a topic-less voice request with notes labels them GROUNDING, after FOCUS TURN', async () => {
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
    expect(userContent).toContain('FOCUS TURN:\nBen: I think they did a cover of Jolene')
    expect(userContent).toContain('GROUNDING:\nBen: so Jack White')
    expect(userContent.indexOf('FOCUS TURN:')).toBeLessThan(userContent.indexOf('GROUNDING:'))
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

describe('applyPlaceholders', () => {
  it('substitutes {current_tab} and {transcript}, leaves unknown placeholders untouched', () => {
    const template = 'Lyrics: {current_tab}\nContext: {transcript}\nAlso: {unknown}'
    const result = applyPlaceholders(template, { currentTab: 'verse one', transcript: 'Host: hi' })
    expect(result).toBe('Lyrics: verse one\nContext: Host: hi\nAlso: {unknown}')
  })

  it('is a no-op on text with no placeholders', () => {
    expect(applyPlaceholders('plain text', { currentTab: 'x' })).toBe('plain text')
  })

  // The full Placeholder set (see CONTEXT.md / ADR-0008). Each one is checked
  // twice: it resolves the value it's given, and — the rule that matters most,
  // because a prompt author writes a Placeholder for context that may simply
  // not exist yet — it resolves to '' when nothing supplies it, silently.
  it('substitutes {selection}', () => {
    expect(applyPlaceholders('Explain: {selection}', { selection: 'the Monroe Doctrine' })).toBe(
      'Explain: the Monroe Doctrine'
    )
  })

  it('substitutes {video_title} independently of {current_tab}', () => {
    const result = applyPlaceholders('{video_title} // {current_tab}', {
      videoTitle: 'Episode 12',
      currentTab: 'Video: Episode 12\n\nsome notes'
    })
    expect(result).toBe('Episode 12 // Video: Episode 12\n\nsome notes')
  })

  it('substitutes {current_time}', () => {
    expect(applyPlaceholders('Now: {current_time}', { currentTime: '2026-09-09T10:00:00.000Z' })).toBe(
      'Now: 2026-09-09T10:00:00.000Z'
    )
  })

  it('substitutes {latest_transcript} from an explicitly supplied value', () => {
    expect(applyPlaceholders('Recent: {latest_transcript}', { latestTranscript: 'Host: just now' })).toBe(
      'Recent: Host: just now'
    )
  })

  it.each([
    ['{current_tab}', 'current_tab'],
    ['{transcript}', 'transcript'],
    ['{selection}', 'selection'],
    ['{video_title}', 'video_title'],
    ['{current_time}', 'current_time'],
    ['{latest_transcript}', 'latest_transcript']
  ])('resolves %s to an empty string when nothing supplies it', (placeholder) => {
    expect(applyPlaceholders(`[${placeholder}]`, {})).toBe('[]')
    expect(applyPlaceholders(`[${placeholder}]`)).toBe('[]')
  })

  it('resolves every placeholder at once when all six are supplied', () => {
    const template = '{selection}|{current_tab}|{video_title}|{transcript}|{latest_transcript}|{current_time}'
    const result = applyPlaceholders(template, {
      selection: 'sel',
      currentTab: 'tab',
      videoTitle: 'title',
      transcript: 'full',
      latestTranscript: 'recent',
      currentTime: 'now'
    })
    expect(result).toBe('sel|tab|title|full|recent|now')
  })

  it('derives {latest_transcript} from {transcript} when no explicit window is supplied', () => {
    const transcript = 'Host: one two three'
    expect(applyPlaceholders('{latest_transcript}', { transcript })).toBe(transcript)
  })

  it('windows a derived {latest_transcript} to the last 700 words, while {transcript} stays whole', () => {
    const transcript = Array.from({ length: 900 }, (_, i) => `w${i}`).join(' ')
    const resolved = applyPlaceholders('{latest_transcript}', { transcript })
    const words = resolved.split(/\s+/)

    expect(words).toHaveLength(LATEST_TRANSCRIPT_WORD_LIMIT)
    expect(words[0]).toBe('w200')
    expect(words.at(-1)).toBe('w899')
    expect(applyPlaceholders('{transcript}', { transcript })).toBe(transcript)
  })

  it('lets an explicit latestTranscript override the derived window', () => {
    const transcript = Array.from({ length: 900 }, (_, i) => `w${i}`).join(' ')
    expect(applyPlaceholders('{latest_transcript}', { transcript, latestTranscript: 'pinned' })).toBe('pinned')
  })
})

// `{#if name}...{/if}` — a host asked for this after finding {latest_transcript}
// always printed something even with nothing recent to show.
describe('applyPlaceholders — {#if name}...{/if} conditional blocks', () => {
  it('keeps the block when the named Placeholder resolved to non-blank text', () => {
    expect(applyPlaceholders('Before. {#if transcript}Context: {transcript}.{/if} After.', { transcript: 'Host: hi' }))
      .toBe('Before. Context: Host: hi. After.')
  })

  it('drops the whole block, markers included, when the Placeholder is unset', () => {
    expect(applyPlaceholders('Before. {#if transcript}Context: {transcript}.{/if} After.', {}))
      .toBe('Before.  After.')
  })

  it('treats a whitespace-only value the same as unset', () => {
    expect(applyPlaceholders('{#if selection}Selected: {selection}{/if}', { selection: '   ' })).toBe('')
  })

  it('an unknown name inside {#if} is always falsy, never a silent pass', () => {
    expect(applyPlaceholders('{#if not_a_real_placeholder}shown{/if}', {})).toBe('')
  })

  it('a bare Placeholder outside any block resolves independently of a same-named condition elsewhere', () => {
    expect(applyPlaceholders('{selection} — {#if selection}yes{/if}', { selection: 'the hook' }))
      .toBe('the hook — yes')
  })

  it('{latest_transcript} inside its own condition avoids always printing something with nothing recent to show', () => {
    expect(applyPlaceholders('{#if latest_transcript}Recently: {latest_transcript}{/if}', { transcript: '' })).toBe('')
    expect(applyPlaceholders('{#if latest_transcript}Recently: {latest_transcript}{/if}', { transcript: 'Host: hi' }))
      .toBe('Recently: Host: hi')
  })

  it('handles more than one block in the same template independently', () => {
    const template = '{#if selection}Sel: {selection}. {/if}{#if transcript}Ctx: {transcript}.{/if}'
    expect(applyPlaceholders(template, { selection: 'x' })).toBe('Sel: x. ')
    expect(applyPlaceholders(template, { transcript: 'y' })).toBe('Ctx: y.')
    expect(applyPlaceholders(template, { selection: 'x', transcript: 'y' })).toBe('Sel: x. Ctx: y.')
  })

  it('a template with no {#if} blocks at all is unaffected', () => {
    expect(applyPlaceholders('Just {selection}, nothing conditional.', { selection: 'x' }))
      .toBe('Just x, nothing conditional.')
  })
})

describe('latestTranscriptWindow', () => {
  it('is the whole transcript when it is shorter than the limit', () => {
    expect(latestTranscriptWindow('Host: hello there')).toBe('Host: hello there')
  })

  it('keeps the last 700 words by default', () => {
    const words = Array.from({ length: 1000 }, (_, i) => `w${i}`)
    const result = latestTranscriptWindow(words.join(' '))
    expect(result.split(' ')).toHaveLength(700)
    expect(result.startsWith('w300 ')).toBe(true)
  })

  it('preserves the newlines between Turns rather than flattening them', () => {
    const transcript = ['Alice: one two', 'Bob: three four', 'Alice: five six'].join('\n')
    expect(latestTranscriptWindow(transcript, 5)).toBe('three four\nAlice: five six')
  })

  it('is empty for an empty, whitespace-only or missing transcript', () => {
    expect(latestTranscriptWindow('')).toBe('')
    expect(latestTranscriptWindow('   \n  ')).toBe('')
    expect(latestTranscriptWindow(null)).toBe('')
    expect(latestTranscriptWindow(undefined)).toBe('')
  })
})

describe('PLACEHOLDER_NAMES', () => {
  it('is exactly the six Placeholders CONTEXT.md documents', () => {
    expect([...PLACEHOLDER_NAMES].sort()).toEqual([
      'current_tab',
      'current_time',
      'latest_transcript',
      'selection',
      'transcript',
      'video_title'
    ])
  })

  // The editor's help list is hand-written (research-assistant.js is
  // server-only, so the browser bundle can't import the real set) — this is
  // what stops the two drifting apart.
  it('matches the Placeholder list the Custom Prompt editor advertises', () => {
    expect(PLACEHOLDER_HELP.map((p) => p.name).sort()).toEqual([...PLACEHOLDER_NAMES].sort())
  })
})

describe('askResearchAssistant — Custom (the Research Prompt)', () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = 'test-api-key'
  })

  it('sends the Research Prompt as the whole request, with {current_tab}/{transcript} substituted', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({
        choices: [{ message: { content: 'TSIA: This song is about X.\nEvidence: line 1.', annotations: [] } }]
      })
    )

    const result = await askResearchAssistant(
      {
        kind: 'custom',
        instruction: 'Read {current_tab} against {transcript} and give a TSIA.',
        text: 'verse one about the river',
        transcript: 'Host: I think it is about grief'
      },
      { fetchImpl }
    )

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body)
    // No hardcoded Stage1/Stage2 wrapper any more — the Research Prompt,
    // substituted, is the entire request in one message.
    expect(body.messages).toEqual([
      { role: 'user', content: 'Read verse one about the river against Host: I think it is about grief and give a TSIA.' }
    ])
    const card = JSON.parse(result.answer)
    expect(card.outputType).toBe('custom')
    expect(card.mainTakeaway).toContain('TSIA:')
    // Custom isn't forced through the research-card schema — its reply is
    // used as freeform prose, not field-parsed.
    expect(body.response_format).toBeUndefined()
  })

  it('rejects Custom when no Research Prompt is configured', async () => {
    await expect(
      askResearchAssistant({ kind: 'custom', instruction: '', text: 'verse one', transcript: '' }, { fetchImpl: vi.fn() })
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })
})

describe('askResearchAssistant — voice Ask with a {current_tab}/{transcript} Placeholder', () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = 'test-api-key'
  })

  it('substitutes a Placeholder written into the typed question itself', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(successBody()))

    await askResearchAssistant(
      {
        kind: 'voice',
        query: 'Summarize {current_tab}',
        context: '',
        notes: '',
        currentTab: 'the notes tab text',
        transcript: ''
      },
      { fetchImpl }
    )

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body)
    const userContent = body.messages.find((m) => m.role === 'user').content
    expect(userContent).toContain('Summarize the notes tab text')
  })
})

describe('askResearchAssistant — response shaping', () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = 'test-api-key'
  })

  it('returns the freeform reply and the web-search citations for a typed Ask', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({
        choices: [
          {
            message: {
              content: 'The Monroe Doctrine was a US policy stance from 1823.',
              annotations: [
                { type: 'url_citation', url_citation: { url: 'https://example.com/monroe', title: 'Monroe Doctrine — Britannica' } },
                { type: 'url_citation', url_citation: { url: 'https://example.com/monroe2', title: 'Monroe Doctrine — Wikipedia' } }
              ]
            }
          }
        ]
      })
    )

    const result = await askResearchAssistant(
      { kind: 'voice', query: 'the Monroe Doctrine', context: '', notes: '' },
      { fetchImpl }
    )

    const card = JSON.parse(result.answer)
    expect(card.mainTakeaway).toBe('The Monroe Doctrine was a US policy stance from 1823.')
    expect(card.outputType).toBe('ask')
    expect(result.citations).toEqual([
      { url: 'https://example.com/monroe', title: 'Monroe Doctrine — Britannica' },
      { url: 'https://example.com/monroe2', title: 'Monroe Doctrine — Wikipedia' }
    ])
  })

  it('logs which model actually served the reply, token usage, and latency for the eval log', async () => {
    appendResearchEvalLog.mockClear()
    process.env.OPENROUTER_MODEL = 'openai/gpt-4o-mini'
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({
        ...successBody(),
        // OpenRouter can route to a fallback model, so the served model
        // can differ from the one requested.
        model: 'openai/gpt-4o-mini-2024-07-18',
        usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 }
      })
    )

    await askResearchAssistant({ kind: 'voice', query: 'the Monroe Doctrine', context: '', notes: '' }, { fetchImpl })

    expect(appendResearchEvalLog).toHaveBeenCalledTimes(1)
    const [entry] = appendResearchEvalLog.mock.calls[0]
    expect(entry.requestedModel).toBe('openai/gpt-4o-mini')
    expect(entry.model).toBe('openai/gpt-4o-mini-2024-07-18')
    expect(entry.usage).toEqual({ prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 })
    expect(typeof entry.durationMs).toBe('number')
    expect(entry.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('logs the unsubstituted Custom Prompt even when the call itself is a plain Ask', async () => {
    appendResearchEvalLog.mockClear()
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(successBody()))

    await askResearchAssistant(
      {
        kind: 'voice',
        query: 'the Monroe Doctrine',
        context: '',
        notes: '',
        researchPrompt: 'Read {current_tab}. Return PROFESSIONAL / FANDOM / AI TSIA.'
      },
      { fetchImpl }
    )

    const [entry] = appendResearchEvalLog.mock.calls[0]
    expect(entry.researchPrompt).toBe('Read {current_tab}. Return PROFESSIONAL / FANDOM / AI TSIA.')
    // The prompt was not sent on this Ask — messages stay the built-in system + question.
    expect(entry.messages.some((m) => String(m.content).includes('AI TSIA'))).toBe(false)
  })

  it('logs the Custom Prompt template, not the placeholder-substituted message', async () => {
    appendResearchEvalLog.mockClear()
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({
        choices: [{ message: { content: 'This song is about grief.', annotations: [] } }]
      })
    )

    await askResearchAssistant(
      {
        kind: 'custom',
        instruction: 'Read {current_tab} against {transcript} and give a TSIA.',
        text: 'verse one about the river',
        transcript: 'Host: I think it is about grief'
      },
      { fetchImpl }
    )

    const [entry] = appendResearchEvalLog.mock.calls[0]
    expect(entry.researchPrompt).toBe('Read {current_tab} against {transcript} and give a TSIA.')
    expect(entry.messages[0].content).toContain('verse one about the river')
    expect(entry.messages[0].content).not.toContain('{current_tab}')
  })

  // ADR-0008/ticket 07 retired the score-threshold and mode-match guards
  // along with the fixed Turn Action modes they only ever policed — every
  // reply is now used as-is, whatever the model actually said, with
  // nothing left that could discard it.
  it('uses the model reply as-is, with no suppression guard left to discard it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({ choices: [{ message: { content: 'A plain, unlabeled answer.', annotations: [] } }] })
    )

    const result = await askResearchAssistant(
      { kind: 'voice', query: 'x', context: '', notes: '' },
      { fetchImpl }
    )

    expect(JSON.parse(result.answer).mainTakeaway).toBe('A plain, unlabeled answer.')
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

// ─── Highlight → Custom Prompt request building (ADR-0008, ticket 05) ──────
//
// This is the ADR's central lesson under test. The design session's real
// failure was a fixed lookup mode that, handed a whole lyric as grounding,
// leaked thematic interpretation the hosts had not yet discussed on air. The
// fix was "the host writes their own prompt" — which is only a real fix if a
// prompt written to reference `{selection}` alone genuinely receives nothing
// but the highlighted excerpt.

describe('referencedPlaceholders', () => {
  it('reports only the Placeholders a template actually writes', () => {
    expect([...referencedPlaceholders('Define {selection} using {transcript}.')].sort())
      .toEqual(['selection', 'transcript'])
  })

  it('ignores braces that are not Placeholders, so prose survives untouched', () => {
    expect([...referencedPlaceholders('Use {selection} but not {made_up} or {}.')])
      .toEqual(['selection'])
    expect([...referencedPlaceholders('')]).toEqual([])
    expect([...referencedPlaceholders(null)]).toEqual([])
  })

  // A name used only inside {#if name} still needs its ingredient carried —
  // otherwise the condition is withheld the value it exists to check.
  it('counts a name used only inside {#if name} as referenced', () => {
    expect([...referencedPlaceholders('{#if transcript}there was some talk{/if}')])
      .toEqual(['transcript'])
  })

  it('reports a name referenced both plainly and inside a condition once', () => {
    expect([...referencedPlaceholders('{#if selection}About: {selection}{/if}')])
      .toEqual(['selection'])
  })
})

describe('buildCustomPromptRequest — a prompt only ever receives what it asked for', () => {
  const everything = {
    selection: 'the second verse',
    currentTab: 'ALL THE NOTES, including where the episode is going',
    transcript: 'Host: we have not talked about this yet',
    videoTitle: 'Episode 12'
  }

  /** The exact messages this request would put on the wire to OpenRouter. */
  async function sentMessages(request, pressTime = new Date()) {
    process.env.OPENROUTER_API_KEY = 'test-api-key'
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({ choices: [{ message: { content: 'an answer', annotations: [] } }] })
    )
    await askResearchAssistant(request, { fetchImpl, pressTime })
    return JSON.parse(fetchImpl.mock.calls[0][1].body).messages
  }

  it('SPOILER RISK: a {selection}-only prompt receives the excerpt and nothing else', async () => {
    const request = buildCustomPromptRequest({
      template: 'Give a plain-language reading of: {selection}',
      ...everything
    })

    expect(request.selection).toBe('the second verse')
    // Not merely left unsubstituted — absent from the request entirely, so
    // there is nothing here for a later change to the prompt-assembly code
    // to accidentally start including.
    expect(request.text).toBe('')
    expect(request.transcript).toBe('')
    expect(request.videoTitle).toBe('')

    // And end to end: nothing but the excerpt reaches the model.
    const sent = JSON.stringify(await sentMessages(request))
    expect(sent).toContain('the second verse')
    expect(sent).not.toContain('ALL THE NOTES')
    expect(sent).not.toContain('we have not talked about this yet')
    expect(sent).not.toContain('Episode 12')
  })

  it('a prompt that DOES reference {transcript} still gets the whole transcript', () => {
    const request = buildCustomPromptRequest({
      template: 'Given {transcript}, is {selection} already settled?',
      ...everything
    })
    expect(request.transcript).toBe('Host: we have not talked about this yet')
    expect(request.selection).toBe('the second verse')
    // Still not the notes — it did not ask for those.
    expect(request.text).toBe('')
  })

  it('{latest_transcript} is windowed from the same ingredient, so it counts as asking for it', () => {
    const request = buildCustomPromptRequest({ template: 'Recently: {latest_transcript}', ...everything })
    expect(request.transcript).toBe('Host: we have not talked about this yet')
  })

  it('{current_tab} and {video_title} are each carried only when referenced', () => {
    const tabOnly = buildCustomPromptRequest({ template: 'Notes: {current_tab}', ...everything })
    expect(tabOnly.text).toBe('ALL THE NOTES, including where the episode is going')
    expect(tabOnly.videoTitle).toBe('')
    expect(buildCustomPromptRequest({ template: 'Title: {video_title}', ...everything }).videoTitle)
      .toBe('Episode 12')
  })

  it('{current_time} needs no ingredient and is filled from the press time', async () => {
    const request = buildCustomPromptRequest({ template: 'It is {current_time}.', ...everything })
    const messages = await sentMessages(request, new Date('2026-09-09T12:00:00.000Z'))
    expect(messages[0].content).toBe('It is 2026-09-09T12:00:00.000Z.')
  })

  it('sends the template as the whole request, Placeholders resolved, no wrapper prompt', async () => {
    const request = buildCustomPromptRequest({ template: 'Fact-check this claim: {selection}', ...everything })
    expect(await sentMessages(request)).toEqual([
      { role: 'user', content: 'Fact-check this claim: the second verse' }
    ])
  })

  it('logs the unsubstituted template, so the Eval Log shows the prompt behind the call', () => {
    expect(buildCustomPromptRequest({ template: 'Define {selection}', ...everything }).researchPrompt)
      .toBe('Define {selection}')
  })

  it('returns null for a blank or missing template rather than an empty lookup', () => {
    expect(buildCustomPromptRequest({ template: '   ', ...everything })).toBe(null)
    expect(buildCustomPromptRequest({ template: null })).toBe(null)
    expect(buildCustomPromptRequest()).toBe(null)
  })

  // {#if transcript} only works if the transcript ingredient actually
  // reaches the model — otherwise the condition can never see a value to
  // check and always resolves false.
  it('carries an ingredient referenced only inside {#if}, so the condition can actually see it', async () => {
    const request = buildCustomPromptRequest({
      template: '{#if transcript}Given {transcript}, is {selection} settled?{/if}',
      ...everything
    })
    expect(request.transcript).toBe('Host: we have not talked about this yet')
    expect(await sentMessages(request)).toEqual([
      { role: 'user', content: 'Given Host: we have not talked about this yet, is the second verse settled?' }
    ])
  })

  it('bounds every ingredient it does carry', () => {
    const request = buildCustomPromptRequest({
      template: '{selection} {current_tab} {transcript} {video_title}',
      selection: 'x'.repeat(30_000),
      currentTab: 'y'.repeat(30_000),
      transcript: 'z'.repeat(30_000),
      videoTitle: 'w'.repeat(30_000)
    })
    for (const value of [request.selection, request.text, request.transcript, request.videoTitle]) {
      expect(value.length).toBe(20_000)
    }
  })
})
