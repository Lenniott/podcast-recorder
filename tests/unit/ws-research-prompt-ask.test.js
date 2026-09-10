import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// ─── Mock db so ws-rooms doesn't need a real DB ─────────────────────────────
vi.mock('../../src/lib/server/db.js', () => ({
  getActiveRoomBySlug: vi.fn(() => ({
    slug: 'room1',
    password_hash: 'mock-hash',
    guest_ai_allowed: 0
  })),
  // The Custom Prompt list (ticket 02). ws-rooms resolves a prompt's
  // template by id server-side — the template text never rides the wire.
  getCustomPrompt: vi.fn(),
  recordResearchUsage: vi.fn(),
  default: {}
}))

vi.mock('../../src/lib/server/auth.js', () => ({
  getHostClaim: vi.fn((slug, cookies, room) => !!room && cookies.get(`pr_host_${slug}`) === 'valid-host-token'),
  makeServerCopyToken: vi.fn((slug, clientId) => `token:${slug}:${clientId}`)
}))

// The Eval Log writes to disk on every lookup — not what this suite is about.
vi.mock('../../src/lib/server/research-eval-log.js', () => ({
  appendResearchEvalLog: vi.fn()
}))

import { getActiveRoomBySlug, getCustomPrompt } from '../../src/lib/server/db.js'
import { setupWss, _resetRooms, _setResearchFetchForTests } from '../../src/lib/server/ws-rooms.js'
import { mockWs, mockWss, join } from './ws-test-helpers.js'

// NOTHING in this file may reach OpenRouter — same two independent guards
// ws-annotation-ask.test.js uses.
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => {
    throw new Error('A test tried to make a real network call to the Research Assistant.')
  }))
})

afterEach(() => {
  _setResearchFetchForTests(null)
  vi.unstubAllGlobals()
})

// A panel-button Custom Prompt — no {selection}, so it has nothing to do
// with a highlight at all (that's the whole reason it gets a panel button
// instead of a popup entry — see db.js's listCustomPromptSummaries).
const DAILY_RECAP = {
  id: 'cp_recap',
  title: 'Daily recap',
  prompt: 'Summarize {transcript} so far in one line.'
}

// A 'blocks'-format panel-button Custom Prompt (structured-research-output
// ticket 03, mirroring HICKS_LAW_BLOCKS in ws-annotation-ask.test.js) — the
// format is resolved server-side from the stored prompt, never something
// the wire message controls.
const RECAP_BLOCKS = {
  id: 'cp_recap_blocks',
  title: 'Recap (blocks)',
  prompt: 'Summarize {transcript} so far as blocks.',
  outputFormat: 'blocks'
}

function latest(ws, type) {
  return ws.sent.filter((m) => m.type === type).at(-1)
}

function assistantReply(takeaway, citations = []) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [
        {
          message: {
            content: takeaway,
            annotations: citations.map((url) => ({ type: 'url_citation', url_citation: { url, title: url } }))
          }
        }
      ]
    })
  }
}

/** One structured-output model reply — the `{blocks: [...]}` JSON a
 *  'blocks'-format request's response_format guarantees (research-blocks.js).
 *  Mirrors ws-annotation-ask.test.js's own helper of the same name. */
function blocksReply(blocks) {
  return assistantReply(JSON.stringify({ blocks }))
}

async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('setupWss — panel button → Custom Prompt → research entry (no highlight involved)', () => {
  let wss, host, guest, fetchCalls

  function useAssistant(reply) {
    _setResearchFetchForTests(async (url, init) => {
      fetchCalls.push({ url, body: JSON.parse(init.body) })
      return reply()
    })
  }

  beforeEach(() => {
    _resetRooms()
    getCustomPrompt.mockReset()
    getCustomPrompt.mockImplementation((id) => {
      if (id === DAILY_RECAP.id) return { ...DAILY_RECAP }
      if (id === RECAP_BLOCKS.id) return { ...RECAP_BLOCKS }
      return null
    })
    getActiveRoomBySlug.mockReturnValue({ slug: 'room1', password_hash: 'mock-hash', guest_ai_allowed: 0 })
    process.env.OPENROUTER_API_KEY = 'test-api-key-never-sent-anywhere'

    fetchCalls = []
    useAssistant(() => assistantReply('Talked about the tour dates.'))

    wss = mockWss()
    setupWss(wss)
    host = mockWs()
    guest = mockWs()
    wss.connect(host, 'room1', { asHost: true }); join(host, 'Host', 'c1')
    wss.connect(guest, 'room1');                  join(guest, 'Guest', 'c2')
  })

  function activeTabId(ws) {
    return latest(ws, 'tabs_state').activeTabId
  }

  function ask(ws, over = {}) {
    ws.emit('message', JSON.stringify({
      type: 'research_prompt_ask',
      entryId: 'entry-1',
      customPromptId: DAILY_RECAP.id,
      currentTab: 'NOTES CONTEXT',
      transcript: 'Host: we should talk about the tour dates',
      videoTitle: 'Episode 12',
      ...over
    }))
  }

  it('creates a pending research entry under the active tab, broadcasts it, then broadcasts the answer', async () => {
    const tabId = activeTabId(host)
    host.sent.length = 0
    guest.sent.length = 0
    ask(host)

    for (const ws of [host, guest]) {
      const pending = latest(ws, 'research_entry')
      expect(pending.tabId).toBe(tabId)
      expect(pending.entry).toMatchObject({
        id: 'entry-1',
        status: 'pending',
        answer: null,
        // The prompt's title stands in for a typed question.
        question: 'Daily recap'
      })
    }

    await settle()

    for (const ws of [host, guest]) {
      const answered = latest(ws, 'research_entry')
      expect(answered.entry).toMatchObject({ id: 'entry-1', status: 'answered' })
    }
  })

  it('lands in the research entries list, never as an Annotation', async () => {
    ask(host)
    await settle()
    expect(host.sent.some((m) => m.type === 'annotation_entry')).toBe(false)
    expect(host.sent.some((m) => m.type === 'research_entry')).toBe(true)
  })

  it('sends only the Placeholder ingredients the template actually references', async () => {
    ask(host)
    await settle()

    expect(fetchCalls).toHaveLength(1)
    const sent = JSON.stringify(fetchCalls[0].body.messages)
    expect(sent).toContain('Host: we should talk about the tour dates')
    // Referenced only {transcript} — the notes/video title are dropped.
    expect(sent).not.toContain('NOTES CONTEXT')
    expect(sent).not.toContain('Episode 12')
  })

  it('a guest without Guest Research Access cannot trigger a panel prompt', async () => {
    guest.sent.length = 0
    ask(guest)
    await settle()

    expect(guest.sent.some((m) => m.type === 'error')).toBe(true)
    expect(guest.sent.some((m) => m.type === 'research_entry')).toBe(false)
    expect(fetchCalls).toHaveLength(0)
  })

  it('with Guest Research Access on, a guest can trigger one — same gate as Ask/annotation_ask', async () => {
    _resetRooms()
    getActiveRoomBySlug.mockReturnValue({ slug: 'room2', password_hash: 'mock-hash', guest_ai_allowed: 1 })
    const wss2 = mockWss()
    setupWss(wss2)
    const g = mockWs()
    wss2.connect(g, 'room2'); join(g, 'Guest', 'c9')
    g.emit('message', JSON.stringify({
      type: 'research_prompt_ask',
      entryId: 'entry-9',
      customPromptId: DAILY_RECAP.id
    }))
    await settle()

    expect(g.sent.some((m) => m.type === 'error')).toBe(false)
    expect(latest(g, 'research_entry').entry).toMatchObject({ id: 'entry-9', status: 'answered' })
  })

  it('a failed lookup errors the entry rather than leaving it pending', async () => {
    useAssistant(() => ({ ok: false, status: 500, json: async () => ({}) }))
    host.sent.length = 0
    ask(host)
    await settle()

    const errored = latest(host, 'research_entry')
    expect(errored.entry).toMatchObject({ id: 'entry-1', status: 'errored', answer: null })
    expect(errored.entry.error).toMatch(/could not be reached/i)
  })

  it('an empty answer errors rather than resolving to a blank entry', async () => {
    useAssistant(() => assistantReply('   '))
    host.sent.length = 0
    ask(host)
    await settle()
    expect(latest(host, 'research_entry').entry.status).toBe('errored')
  })

  it('refuses an unknown Custom Prompt id without creating an entry', async () => {
    host.sent.length = 0
    ask(host, { customPromptId: 'cp_gone' })
    await settle()
    expect(host.sent.some((m) => m.type === 'error')).toBe(true)
    expect(host.sent.some((m) => m.type === 'research_entry')).toBe(false)
    expect(fetchCalls).toHaveLength(0)
  })

  it('files the entry under the room\'s CURRENT active tab, ignoring any tabId a client might send', async () => {
    const firstTab = activeTabId(host)
    host.emit('message', JSON.stringify({ type: 'tab_create', tabId: 'tab-second' }))
    expect(activeTabId(host)).toBe('tab-second')

    ask(host, { tabId: firstTab })
    await settle()

    expect(latest(host, 'research_entry').tabId).toBe('tab-second')
  })

  it('a late joiner is replayed the resolved entry via research_state', async () => {
    ask(host)
    await settle()

    const tabId = activeTabId(host)
    const rejoiner = mockWs()
    wss.connect(rejoiner, 'room1'); join(rejoiner, 'Guest', 'c2')
    const replay = latest(rejoiner, 'research_state')
    expect(replay).toEqual({
      type: 'research_state',
      tabId,
      entries: [expect.objectContaining({ id: 'entry-1', status: 'answered' })]
    })
  })

  // A 'blocks'-format panel-button Custom Prompt (structured-research-output
  // ticket 03) — mirrors ws-annotation-ask.test.js's own "blocks"-format
  // Custom Prompt coverage for the Card/Annotation path.
  describe('a "blocks"-format Custom Prompt', () => {
    it('attaches the structured-output response_format to the outgoing request', async () => {
      useAssistant(() => blocksReply([{ type: 'paragraph', text: 'x', items: null, label: null, value: null }]))
      ask(host, { customPromptId: RECAP_BLOCKS.id })
      await settle()

      expect(fetchCalls[0].body.response_format).toEqual(
        expect.objectContaining({ type: 'json_schema', json_schema: expect.objectContaining({ name: 'research_blocks' }) })
      )
    })

    it('a plain "text"-format prompt (DAILY_RECAP) attaches no response_format — unaffected by this feature existing', async () => {
      ask(host)
      await settle()
      expect(fetchCalls[0].body.response_format).toBeUndefined()
    })

    it('resolves the entry with both a structured blocks array and a flattened-text fallback', async () => {
      useAssistant(() =>
        blocksReply([
          { type: 'paragraph', text: 'Talked about the tour dates.', items: null, label: null, value: null },
          { type: 'list', text: null, items: ['tour dates', 'ticket prices'], label: null, value: null }
        ])
      )
      ask(host, { customPromptId: RECAP_BLOCKS.id })
      await settle()

      const answered = latest(host, 'research_entry').entry
      expect(answered.status).toBe('answered')
      expect(answered.blocks).toEqual([
        { type: 'paragraph', text: 'Talked about the tour dates.' },
        { type: 'list', items: ['tour dates', 'ticket prices'] }
      ])
      // A renderer that only knows `answer` (the serialized research card —
      // see research-card.js) still sees something readable via its
      // mainTakeaway, the flattened-text fallback.
      expect(JSON.parse(answered.answer).mainTakeaway).toBe('Talked about the tour dates.\n\n• tour dates\n• ticket prices')

      // And a late joiner's replay carries the same structured shape.
      const rejoiner = mockWs()
      wss.connect(rejoiner, 'room1'); join(rejoiner, 'Guest', 'c2')
      expect(latest(rejoiner, 'research_state').entries[0].blocks).toEqual(answered.blocks)
    })

    it('an empty blocks: [] reply errors the entry rather than resolving to a blank one', async () => {
      useAssistant(() => blocksReply([]))
      host.sent.length = 0
      ask(host, { customPromptId: RECAP_BLOCKS.id })
      await settle()

      const errored = latest(host, 'research_entry')
      expect(errored.entry.status).toBe('errored')
      expect(errored.entry.blocks).toBe(null)
    })

    it('a typed Ask (research_resolve) still has blocks: null', async () => {
      host.sent.length = 0
      host.emit('message', JSON.stringify({ type: 'research_ask', entryId: 'ask-1', question: 'What time is it?' }))
      host.emit('message', JSON.stringify({
        type: 'research_resolve',
        entryId: 'ask-1',
        answer: JSON.stringify({ mainTakeaway: 'It is noon.', outputType: 'ask' }),
        citations: []
      }))
      expect(latest(host, 'research_entry').entry.blocks).toBe(null)
    })
  })
})
