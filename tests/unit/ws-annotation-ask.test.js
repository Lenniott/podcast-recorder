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

// NOTHING in this file may reach OpenRouter. Two independent guards:
//
//  1. every Research Assistant call is routed through an injected fake (see
//     _setResearchFetchForTests in beforeEach) — the same fetchImpl seam
//     research-assistant.test.js uses, so the real fetch is never consulted;
//  2. the global fetch is replaced with a tripwire that fails the test
//     loudly, so a path that somehow escaped guard 1 shows up as a failure
//     rather than as a real, paid request.
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => {
    throw new Error('A test tried to make a real network call to the Research Assistant.')
  }))
})

afterEach(() => {
  _setResearchFetchForTests(null)
  vi.unstubAllGlobals()
})

const FACT_CHECK = {
  id: 'cp_fact',
  title: 'Fact check',
  prompt: 'Fact-check exactly this and nothing else: {selection}'
}

// A 'blocks'-format Custom Prompt (structured-research-output ticket 02).
const HICKS_LAW_BLOCKS = {
  id: 'cp_hicks',
  title: 'Explain',
  prompt: 'Explain {selection} in plain terms.',
  outputFormat: 'blocks'
}

function latest(ws, type) {
  return ws.sent.filter((m) => m.type === type).at(-1)
}

function all(ws, type) {
  return ws.sent.filter((m) => m.type === type)
}

/** One model reply, in the plain labeled-field shape research-card.js parses. */
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
 *  'blocks'-format request's response_format guarantees (research-blocks.js). */
function blocksReply(blocks) {
  return assistantReply(JSON.stringify({ blocks }))
}

/** Lets the fire-and-forget lookup inside the handler finish before asserting. */
async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('setupWss — highlight → Custom Prompt → Card Annotation (ADR-0008, ticket 05)', () => {
  let wss, host, guest, fetchCalls, roomTabId

  /** Every Research Assistant call in this suite goes here, never to a
   *  network. Swap the reply with `respondWith`. */
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
      if (id === FACT_CHECK.id) return { ...FACT_CHECK }
      if (id === HICKS_LAW_BLOCKS.id) return { ...HICKS_LAW_BLOCKS }
      return null
    })
    getActiveRoomBySlug.mockReturnValue({ slug: 'room1', password_hash: 'mock-hash', guest_ai_allowed: 0 })
    // A key has to be present or askResearchAssistant refuses before it ever
    // builds a request — this is a stand-in, and the injected fake above is
    // what actually answers, so it is never sent anywhere.
    process.env.OPENROUTER_API_KEY = 'test-api-key-never-sent-anywhere'

    fetchCalls = []
    useAssistant(() => assistantReply('Apollo 11 landed on 20 July 1969.'))

    wss = mockWss()
    setupWss(wss)
    host = mockWs()
    guest = mockWs()
    wss.connect(host, 'room1', { asHost: true }); join(host, 'Host', 'c1')
    wss.connect(guest, 'room1');                  join(guest, 'Guest', 'c2')
    // Captured up front: several cases clear `sent` before asking, which
    // would otherwise take the tabs_state replay with it.
    roomTabId = activeTabId(host)
  })

  function activeTabId(ws) {
    return latest(ws, 'tabs_state').activeTabId
  }

  function ask(ws, over = {}) {
    ws.emit('message', JSON.stringify({
      type: 'annotation_ask',
      tabId: roomTabId,
      id: 'card-1',
      kind: 'card',
      customPromptId: FACT_CHECK.id,
      quote: 'the moon landing',
      currentTab: 'NOTES THE PROMPT DID NOT ASK FOR',
      transcript: 'Host: TRANSCRIPT THE PROMPT DID NOT ASK FOR',
      videoTitle: 'Episode 12',
      ...over
    }))
  }

  it('creates a pending Card, broadcasts it immediately, then broadcasts the answer', async () => {
    const tabId = activeTabId(host)
    host.sent.length = 0
    guest.sent.length = 0
    ask(host)

    // Pending, before the lookup has resolved — every peer sees the click
    // did something, straight away.
    for (const ws of [host, guest]) {
      const pending = latest(ws, 'annotation_entry')
      expect(pending.tabId).toBe(tabId)
      expect(pending.entry).toMatchObject({
        id: 'card-1',
        kind: 'card',
        status: 'pending',
        quote: 'the moon landing',
        text: '',
        customPromptId: FACT_CHECK.id,
        // A Card is authored by the prompt, not the person who highlighted.
        author: 'Fact check'
      })
    }

    await settle()

    for (const ws of [host, guest]) {
      const answered = latest(ws, 'annotation_entry')
      expect(answered.entry).toMatchObject({
        id: 'card-1',
        kind: 'card',
        status: 'answered',
        text: 'Apollo 11 landed on 20 July 1969.',
        // The frozen quote is untouched by resolving.
        quote: 'the moon landing'
      })
    }
  })

  it('lands the Card in the SAME per-tab list Comments are in', async () => {
    const tabId = activeTabId(host)
    host.emit('message', JSON.stringify({
      type: 'annotation_create', tabId, id: 'ann-1', kind: 'comment', quote: 'the moon landing', text: 'my note'
    }))
    ask(host)
    await settle()

    const rejoiner = mockWs()
    wss.connect(rejoiner, 'room1'); join(rejoiner, 'Guest', 'c2')
    const state = latest(rejoiner, 'annotation_state')
    expect(state.tabId).toBe(tabId)
    expect(state.entries.map((e) => [e.id, e.kind])).toEqual([
      ['ann-1', 'comment'],
      ['card-1', 'card']
    ])
  })

  it('SPOILER RISK: a {selection}-only prompt is sent the excerpt and nothing else', async () => {
    ask(host)
    await settle()

    expect(fetchCalls).toHaveLength(1)
    const sent = JSON.stringify(fetchCalls[0].body.messages)
    expect(sent).toContain('the moon landing')
    // The ask carried the notes, transcript and video title as available
    // ingredients — this prompt referenced none of them, so none of them
    // reached the model. This is ADR-0008's whole rationale.
    expect(sent).not.toContain('NOTES THE PROMPT DID NOT ASK FOR')
    expect(sent).not.toContain('TRANSCRIPT THE PROMPT DID NOT ASK FOR')
    expect(sent).not.toContain('Episode 12')
    expect(fetchCalls[0].body.messages).toEqual([
      { role: 'user', content: 'Fact-check exactly this and nothing else: the moon landing' }
    ])
  })

  it('a prompt that references {transcript} does receive the transcript too', async () => {
    getCustomPrompt.mockReturnValue({
      id: 'cp_x', title: 'Settled?', prompt: 'Is {selection} settled given {transcript}?'
    })
    ask(host, { customPromptId: 'cp_x' })
    await settle()

    const content = fetchCalls[0].body.messages[0].content
    expect(content).toContain('the moon landing')
    expect(content).toContain('TRANSCRIPT THE PROMPT DID NOT ASK FOR')
  })

  it('resolves {selection} from the stored frozen quote, not the raw wire value', async () => {
    ask(host, { quote: '   the moon landing   ' })
    await settle()
    expect(fetchCalls[0].body.messages[0].content)
      .toBe('Fact-check exactly this and nothing else: the moon landing')
  })

  it('a guest without Guest Research Access cannot trigger a Custom Prompt', async () => {
    guest.sent.length = 0
    ask(guest)
    await settle()

    expect(guest.sent.some((m) => m.type === 'error')).toBe(true)
    expect(guest.sent.some((m) => m.type === 'annotation_entry')).toBe(false)
    // No Annotation stored, and no Research Assistant call spent.
    expect(fetchCalls).toHaveLength(0)
    expect(host.sent.some((m) => m.type === 'annotation_entry')).toBe(false)
  })

  it('the same guest CAN still leave a Comment — the gate is on the AI call, not on Annotations', () => {
    const tabId = activeTabId(guest)
    guest.sent.length = 0
    guest.emit('message', JSON.stringify({
      type: 'annotation_create', tabId, id: 'ann-1', kind: 'comment', quote: 'a phrase', text: 'my two cents'
    }))
    expect(guest.sent.some((m) => m.type === 'error')).toBe(false)
    expect(latest(guest, 'annotation_entry').entry.kind).toBe('comment')
  })

  it('with Guest Research Access on, a guest can trigger one — same gate as Ask', async () => {
    _resetRooms()
    getActiveRoomBySlug.mockReturnValue({ slug: 'room2', password_hash: 'mock-hash', guest_ai_allowed: 1 })
    const wss2 = mockWss()
    setupWss(wss2)
    const g = mockWs()
    wss2.connect(g, 'room2'); join(g, 'Guest', 'c9')
    g.emit('message', JSON.stringify({
      type: 'annotation_ask',
      tabId: latest(g, 'tabs_state').activeTabId,
      id: 'card-9',
      kind: 'card',
      customPromptId: FACT_CHECK.id,
      quote: 'a highlighted phrase'
    }))
    await settle()

    expect(g.sent.some((m) => m.type === 'error')).toBe(false)
    expect(latest(g, 'annotation_entry').entry).toMatchObject({ kind: 'card', status: 'answered' })
  })

  it('a failed lookup broadcasts annotation_error — a pending Card is never left stuck', async () => {
    useAssistant(() => ({ ok: false, status: 500, json: async () => ({}) }))
    host.sent.length = 0
    ask(host)
    await settle()

    const errored = latest(host, 'annotation_error')
    expect(errored.id).toBe('card-1')
    expect(errored.message).toMatch(/could not be reached/i)
    expect(errored.entry).toMatchObject({ id: 'card-1', status: 'errored', text: '' })
    expect(errored.entry.error).toBe(errored.message)

    // And the errored state is stored, so a late joiner sees it too.
    const rejoiner = mockWs()
    wss.connect(rejoiner, 'room1'); join(rejoiner, 'Guest', 'c2')
    expect(latest(rejoiner, 'annotation_state').entries[0]).toMatchObject({ status: 'errored' })
  })

  it('an answer with nothing in it errors rather than resolving to a blank Card', async () => {
    useAssistant(() => assistantReply('   '))
    host.sent.length = 0
    ask(host)
    await settle()
    expect(latest(host, 'annotation_error').entry.status).toBe('errored')
  })

  it('refuses an unknown Custom Prompt id without creating an Annotation', async () => {
    host.sent.length = 0
    ask(host, { customPromptId: 'cp_gone' })
    await settle()
    expect(host.sent.some((m) => m.type === 'error')).toBe(true)
    expect(host.sent.some((m) => m.type === 'annotation_entry')).toBe(false)
    expect(fetchCalls).toHaveLength(0)
  })

  it('refuses an unknown tab and an empty quote', async () => {
    for (const over of [{ tabId: 'tab-nope' }, { quote: '   ' }]) {
      host.sent.length = 0
      ask(host, over)
      await settle()
      expect(host.sent.some((m) => m.type === 'error')).toBe(true)
      expect(host.sent.some((m) => m.type === 'annotation_entry')).toBe(false)
    }
    expect(fetchCalls).toHaveLength(0)
  })

  it('a replayed ask re-broadcasts the stored Card and does NOT spend a second lookup', async () => {
    ask(host)
    await settle()
    expect(fetchCalls).toHaveLength(1)

    // What the outbox does after a reconnect it never saw acknowledged.
    host.sent.length = 0
    ask(host)
    await settle()

    expect(fetchCalls).toHaveLength(1)
    expect(latest(host, 'annotation_entry').entry).toMatchObject({
      id: 'card-1', status: 'answered', text: 'Apollo 11 landed on 20 July 1969.'
    })
    const rejoiner = mockWs()
    wss.connect(rejoiner, 'room1'); join(rejoiner, 'Guest', 'c2')
    expect(latest(rejoiner, 'annotation_state').entries).toHaveLength(1)
  })

  it('files the Card under the tab the text was highlighted in, not the current active tab', async () => {
    const firstTab = activeTabId(host)
    host.emit('message', JSON.stringify({ type: 'tab_create', tabId: 'tab-second' }))
    expect(activeTabId(host)).toBe('tab-second')

    ask(host, { tabId: firstTab })
    await settle()

    expect(all(host, 'annotation_entry').every((m) => m.tabId === firstTab)).toBe(true)
  })

  it('keeps the citations the lookup came back with', async () => {
    useAssistant(() => assistantReply('An answer.', ['https://en.wikipedia.org/wiki/Apollo_11']))
    ask(host)
    await settle()
    expect(latest(host, 'annotation_entry').entry.citations).toEqual([
      { url: 'https://en.wikipedia.org/wiki/Apollo_11', title: 'https://en.wikipedia.org/wiki/Apollo_11' }
    ])
  })

  // A 'blocks'-format Custom Prompt (structured-research-output ticket 02) —
  // the format is resolved server-side from the stored prompt, exactly like
  // its template text, never something the wire message controls.
  describe('a "blocks"-format Custom Prompt', () => {
    it('attaches the structured-output response_format to the outgoing request', async () => {
      useAssistant(() => blocksReply([{ type: 'paragraph', text: 'x', items: null, label: null, value: null }]))
      ask(host, { customPromptId: HICKS_LAW_BLOCKS.id })
      await settle()

      expect(fetchCalls[0].body.response_format).toEqual(
        expect.objectContaining({ type: 'json_schema', json_schema: expect.objectContaining({ name: 'research_blocks' }) })
      )
    })

    it('a plain "text"-format prompt (FACT_CHECK) attaches no response_format — unaffected by this feature existing', async () => {
      ask(host)
      await settle()
      expect(fetchCalls[0].body.response_format).toBeUndefined()
    })

    it('resolves the Card with both a structured blocks array and a flattened-text fallback', async () => {
      useAssistant(() =>
        blocksReply([
          { type: 'paragraph', text: 'Hicks Law relates choice count to reaction time.', items: null, label: null, value: null },
          { type: 'list', text: null, items: ['more options', 'slower decisions'], label: null, value: null }
        ])
      )
      ask(host, { customPromptId: HICKS_LAW_BLOCKS.id })
      await settle()

      const answered = latest(host, 'annotation_entry').entry
      expect(answered.status).toBe('answered')
      expect(answered.blocks).toEqual([
        { type: 'paragraph', text: 'Hicks Law relates choice count to reaction time.' },
        { type: 'list', items: ['more options', 'slower decisions'] }
      ])
      // A renderer that only knows `text` (today's panel, ahead of ticket 03)
      // still sees something readable.
      expect(answered.text).toBe('Hicks Law relates choice count to reaction time.\n\n• more options\n• slower decisions')

      // And a late joiner's replay carries the same structured shape.
      const rejoiner = mockWs()
      wss.connect(rejoiner, 'room1'); join(rejoiner, 'Guest', 'c2')
      expect(latest(rejoiner, 'annotation_state').entries[0].blocks).toEqual(answered.blocks)
    })

    it('an empty blocks: [] reply errors the Card rather than resolving to a blank one', async () => {
      useAssistant(() => blocksReply([]))
      host.sent.length = 0
      ask(host, { customPromptId: HICKS_LAW_BLOCKS.id })
      await settle()

      const errored = latest(host, 'annotation_error')
      expect(errored.entry.status).toBe('errored')
      expect(errored.entry.blocks).toBe(null)
    })

    it('a Comment (no Custom Prompt involved) still has blocks: null', async () => {
      const tabId = activeTabId(host)
      host.emit('message', JSON.stringify({
        type: 'annotation_create', tabId, id: 'ann-plain', kind: 'comment', quote: 'a phrase', text: 'just a note'
      }))
      expect(latest(host, 'annotation_entry').entry.blocks).toBe(null)
    })
  })
})
