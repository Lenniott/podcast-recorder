import { describe, it, expect, beforeEach, vi } from 'vitest'

// ─── Mock db so ws-rooms doesn't need a real DB ─────────────────────────────
vi.mock('../../src/lib/server/db.js', () => ({
  getActiveRoomBySlug: vi.fn(() => ({
    slug: 'room1',
    password_hash: 'mock-hash',
    guest_ai_allowed: 0
  })),
  // ws-rooms resolves an annotation_ask's Custom Prompt by id (ticket 05);
  // research-assistant records usage. Neither is exercised by this Comment
  // suite — see ws-annotation-ask.test.js — but both must exist to import.
  getCustomPrompt: vi.fn(() => null),
  recordResearchUsage: vi.fn(),
  default: {}
}))

// ─── Mock auth so a known cookie value grants the host claim ────────────────
vi.mock('../../src/lib/server/auth.js', () => ({
  getHostClaim: vi.fn((slug, cookies, room) => !!room && cookies.get(`pr_host_${slug}`) === 'valid-host-token'),
  makeServerCopyToken: vi.fn((slug, clientId) => `token:${slug}:${clientId}`)
}))

import { getActiveRoomBySlug } from '../../src/lib/server/db.js'
import { setupWss, _resetRooms } from '../../src/lib/server/ws-rooms.js'
import { mockWs, mockWss, join } from './ws-test-helpers.js'

function latest(ws, type) {
  return ws.sent.filter((m) => m.type === type).at(-1)
}

function all(ws, type) {
  return ws.sent.filter((m) => m.type === type)
}

function comment(ws, { tabId, id, quote, text, kind = 'comment' }) {
  ws.emit('message', JSON.stringify({ type: 'annotation_create', tabId, id, kind, quote, text }))
}

describe('setupWss — Annotations (per-tab, shared — see ADR-0008 and ticket 03)', () => {
  let wss, host, guest

  beforeEach(() => {
    _resetRooms()
    wss = mockWss()
    setupWss(wss)
    getActiveRoomBySlug.mockReturnValue({ slug: 'room1', password_hash: 'mock-hash', guest_ai_allowed: 0 })
    host = mockWs()
    guest = mockWs()
    wss.connect(host, 'room1', { asHost: true }); join(host, 'Host', 'c1')
    wss.connect(guest, 'room1');                  join(guest, 'Guest', 'c2')
  })

  function activeTabId(ws) {
    return latest(ws, 'tabs_state').activeTabId
  }

  it('a Comment left on a Transcript Turn is stored and broadcast, filed under the reserved Transcript id', async () => {
    // The end-to-end shape ticket 06 produces: highlight a Turn in the
    // panel's Transcript facet -> the popup's Comment -> annotation_create
    // carrying TRANSCRIPT_TAB_ID as its tabId. The Transcript is never an
    // entry in tabs.list (ADR-0002), so this is the one place that id is a
    // legitimate destination — as a storage key, never as a view.
    const { TRANSCRIPT_TAB_ID } = await import('../../src/lib/room/transcript-sync.js')
    host.emit('message', JSON.stringify({
      type: 'transcript_line', speaker: 'Host', text: 'It was unbearably hot.'
    }))
    host.sent.length = 0
    guest.sent.length = 0

    comment(host, {
      tabId: TRANSCRIPT_TAB_ID, id: 'ann-turn-1', quote: 'unbearably hot', text: 'check the date'
    })

    for (const ws of [host, guest]) {
      const msg = latest(ws, 'annotation_entry')
      expect(msg, 'every peer receives the Turn Annotation').toBeTruthy()
      expect(msg.tabId).toBe(TRANSCRIPT_TAB_ID)
      expect(msg.entry.quote).toBe('unbearably hot')
      expect(msg.entry.text).toBe('check the date')
      expect(msg.entry.author).toBe('Host')
    }
    expect(host.sent.some((m) => m.type === 'error')).toBe(false)
  })

  it('replays Turn Annotations to a late joiner alongside the Notes ones', async () => {
    const { TRANSCRIPT_TAB_ID } = await import('../../src/lib/room/transcript-sync.js')
    const tabId = activeTabId(host)
    comment(host, { tabId, id: 'ann-notes', quote: 'notes quote', text: 'on notes' })
    comment(host, { tabId: TRANSCRIPT_TAB_ID, id: 'ann-turn', quote: 'turn quote', text: 'on a Turn' })

    guest.emit('close') // free a slot
    const late = mockWs()
    wss.connect(late, 'room1'); join(late, 'Late', 'c3')

    const states = late.sent.filter((m) => m.type === 'annotation_state')
    const byTab = Object.fromEntries(states.map((m) => [m.tabId, m.entries]))
    expect(byTab[tabId].map((e) => e.id)).toEqual(['ann-notes'])
    expect(byTab[TRANSCRIPT_TAB_ID].map((e) => e.id)).toEqual(['ann-turn'])
  })

  it('a submitted Comment is stored and broadcast to every participant', () => {
    const tabId = activeTabId(host)
    host.sent.length = 0
    guest.sent.length = 0
    comment(host, { tabId, id: 'a1', quote: 'the moon landing', text: 'check the date on this' })

    for (const ws of [host, guest]) {
      const msg = latest(ws, 'annotation_entry')
      expect(msg.tabId).toBe(tabId)
      expect(msg.entry).toMatchObject({
        id: 'a1',
        tabId,
        kind: 'comment',
        quote: 'the moon landing',
        text: 'check the date on this',
        author: 'Host'
      })
      expect(typeof msg.entry.at).toBe('number')
    }
  })

  it('the author is the creating peer\'s own join name, never a client-supplied one', () => {
    const tabId = activeTabId(host)
    guest.sent.length = 0
    guest.emit('message', JSON.stringify({
      type: 'annotation_create',
      tabId,
      id: 'a1',
      kind: 'comment',
      quote: 'a quote',
      text: 'a note',
      author: 'Somebody Else'
    }))
    expect(latest(guest, 'annotation_entry').entry.author).toBe('Guest')
  })

  it('Guest Research Access is deliberately NOT applied — a guest can comment in a room where they cannot ask', () => {
    // Same room row as the research suite's "a guest cannot ask" case
    // (guest_ai_allowed: 0), so this is specifically about the gate, not
    // about a differently-configured room.
    const tabId = activeTabId(guest)
    guest.sent.length = 0
    host.sent.length = 0

    // Baseline: this guest genuinely is gated out of the Research Assistant.
    guest.emit('message', JSON.stringify({ type: 'research_ask', entryId: 'e1', question: 'anything?' }))
    expect(guest.sent.some((m) => m.type === 'error')).toBe(true)
    expect(guest.sent.some((m) => m.type === 'research_entry')).toBe(false)

    guest.sent.length = 0
    comment(guest, { tabId, id: 'a1', quote: 'a highlighted phrase', text: 'my two cents' })

    expect(guest.sent.some((m) => m.type === 'error')).toBe(false)
    expect(latest(guest, 'annotation_entry').entry.author).toBe('Guest')
    expect(latest(host, 'annotation_entry').entry.text).toBe('my two cents')
  })

  it('rejoining replays every existing Annotation for the tab, before any live one', () => {
    const tabId = activeTabId(host)
    comment(host, { tabId, id: 'a1', quote: 'first quote', text: 'first note' })
    comment(host, { tabId, id: 'a2', quote: 'second quote', text: 'second note' })

    const rejoiner = mockWs()
    wss.connect(rejoiner, 'room1'); join(rejoiner, 'Guest', 'c2')

    const state = latest(rejoiner, 'annotation_state')
    expect(state.tabId).toBe(tabId)
    expect(state.entries.map((e) => e.id)).toEqual(['a1', 'a2'])
    expect(state.entries[0].quote).toBe('first quote')
    // Replayed as part of the join handshake, so it can never arrive after a
    // live annotation_entry for the same connection.
    expect(rejoiner.sent.some((m) => m.type === 'annotation_entry')).toBe(false)
  })

  it('tabs_sync replays Annotations too (a UI remount without a WS reconnect)', () => {
    const tabId = activeTabId(host)
    comment(host, { tabId, id: 'a1', quote: 'a quote', text: 'a note' })
    guest.sent.length = 0
    guest.emit('message', JSON.stringify({ type: 'tabs_sync' }))
    expect(latest(guest, 'annotation_state').entries.map((e) => e.id)).toEqual(['a1'])
  })

  it('re-sending the same annotation id is idempotent — no duplicate Comment', () => {
    const tabId = activeTabId(host)
    comment(host, { tabId, id: 'a1', quote: 'a quote', text: 'a note' })
    const firstAt = latest(host, 'annotation_entry').entry.at

    // What annotation-outbox.js does after a reconnect, including a client
    // that has since edited its own draft: the stored record must win.
    comment(host, { tabId, id: 'a1', quote: 'a different quote', text: 'a different note' })

    const echoed = latest(host, 'annotation_entry').entry
    expect(echoed).toMatchObject({ quote: 'a quote', text: 'a note', at: firstAt })

    // Same clientId as the guest — a reconnect, which replaces that peer's
    // socket rather than being turned away by the 2-peer cap.
    const rejoiner = mockWs()
    wss.connect(rejoiner, 'room1'); join(rejoiner, 'Guest', 'c2')
    expect(latest(rejoiner, 'annotation_state').entries).toHaveLength(1)
  })

  it('refuses an unknown tab, an unknown kind, an empty quote and an empty comment', () => {
    const tabId = activeTabId(host)
    const cases = [
      { tabId: 'tab-nope', id: 'a1', quote: 'q', text: 't' },
      { tabId, id: 'a2', quote: 'q', text: 't', kind: 'nonsense' },
      { tabId, id: 'a3', quote: '   ', text: 't' },
      { tabId, id: 'a4', quote: 'q', text: '   ' }
    ]
    for (const payload of cases) {
      host.sent.length = 0
      comment(host, payload)
      expect(host.sent.some((m) => m.type === 'error')).toBe(true)
      expect(host.sent.some((m) => m.type === 'annotation_entry')).toBe(false)
    }
  })

  it('stores exactly {id,tabId,kind,quote,text,author,at} — no anchor position of any kind (ticket 04)', () => {
    const tabId = activeTabId(host)
    host.emit('message', JSON.stringify({ type: 'tab_text', tabId, text: 'we talked about the moon landing today' }))
    comment(host, { tabId, id: 'a1', quote: 'the moon landing', text: 'check the date' })

    // A client that tries to smuggle an offset in gets it dropped: the
    // stored shape is fixed here, and the highlight is re-located from the
    // frozen quote at render time instead (see notes-highlights.js).
    host.emit('message', JSON.stringify({
      type: 'annotation_create',
      tabId,
      id: 'a2',
      kind: 'comment',
      quote: 'today',
      text: 'and this one',
      start: 33,
      end: 38,
      offset: 33,
      anchor: { start: 33 }
    }))

    const rejoiner = mockWs()
    wss.connect(rejoiner, 'room1'); join(rejoiner, 'Guest', 'c2')
    const entries = latest(rejoiner, 'annotation_state').entries
    expect(entries).toHaveLength(2)
    // The point of this assertion is that NO anchor position is ever
    // stored — not that the shape is frozen forever. Ticket 05 legitimately
    // added Card fields (status/citations/customPromptId/error) to the same
    // record, so the check is "every key is a known, non-positional one"
    // rather than an exact list that a new Annotation kind invalidates.
    const CORE_KEYS = ['at', 'author', 'id', 'kind', 'quote', 'tabId', 'text']
    const CARD_KEYS = ['status', 'citations', 'customPromptId', 'error']
    for (const entry of entries) {
      const keys = Object.keys(entry)
      expect(CORE_KEYS.every((k) => keys.includes(k))).toBe(true)
      expect(keys.filter((k) => ![...CORE_KEYS, ...CARD_KEYS].includes(k))).toEqual([])
      // The smuggled offset fields specifically, named explicitly so this
      // fails loudly rather than by absence if the allow-list ever grows.
      for (const positional of ['start', 'end', 'offset', 'anchor', 'range', 'index']) {
        expect(keys).not.toContain(positional)
      }
    }
  })

  it('editing the tab text never touches a stored Annotation — the quote stays frozen (ticket 04)', () => {
    const tabId = activeTabId(host)
    host.emit('message', JSON.stringify({ type: 'tab_text', tabId, text: 'we talked about the moon landing today' }))
    comment(host, { tabId, id: 'a1', quote: 'the moon landing', text: 'check the date' })

    // The phrase is edited away entirely — the Annotation is unchanged and
    // still replays with its original quote; only the *drawing* of a
    // highlight is affected, and that decision is never persisted.
    host.emit('message', JSON.stringify({ type: 'tab_text', tabId, text: 'we talked about something else' }))

    const rejoiner = mockWs()
    wss.connect(rejoiner, 'room1'); join(rejoiner, 'Guest', 'c2')
    const [entry] = latest(rejoiner, 'annotation_state').entries
    expect(entry).toMatchObject({ id: 'a1', quote: 'the moon landing', text: 'check the date' })
  })

  it('files an Annotation under the tab it was highlighted in, not the room\'s current active tab', () => {
    const firstTab = activeTabId(host)
    host.emit('message', JSON.stringify({ type: 'tab_create', tabId: 'tab-second' }))
    expect(activeTabId(host)).toBe('tab-second')

    // The guest highlighted text in the first tab before the host switched.
    comment(guest, { tabId: firstTab, id: 'a1', quote: 'older tab text', text: 'still about tab one' })
    expect(latest(guest, 'annotation_entry').tabId).toBe(firstTab)

    const rejoiner = mockWs()
    wss.connect(rejoiner, 'room1'); join(rejoiner, 'Guest', 'c2')
    const states = all(rejoiner, 'annotation_state')
    expect(states).toHaveLength(1)
    expect(states[0].tabId).toBe(firstTab)
  })
})
