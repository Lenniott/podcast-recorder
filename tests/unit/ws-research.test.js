import { describe, it, expect, beforeEach, vi } from 'vitest'

// ─── Mock db so ws-rooms doesn't need a real DB ─────────────────────────────
vi.mock('../../src/lib/server/db.js', () => ({
  getActiveRoomBySlug: vi.fn(() => ({
    slug: 'room1',
    password_hash: 'mock-hash'
  })),
  default: {}
}))

// ─── Mock auth so a known cookie value grants the host claim ────────────────
vi.mock('../../src/lib/server/auth.js', () => ({
  getHostClaim: vi.fn((slug, cookies, room) => !!room && cookies.get(`pr_host_${slug}`) === 'valid-host-token'),
  makeServerCopyToken: vi.fn((slug, clientId) => `token:${slug}:${clientId}`)
}))

import { getActiveRoomBySlug } from '../../src/lib/server/db.js'
import { setupWss, _resetRooms, researchGuestCanAsk } from '../../src/lib/server/ws-rooms.js'
import { mockWs, mockWss, join } from './ws-test-helpers.js'

function latest(ws, type) {
  return ws.sent.filter((m) => m.type === type).at(-1)
}

function ask(ws, { entryId, question }) {
  ws.emit('message', JSON.stringify({ type: 'research_ask', entryId, question }))
}

describe('researchGuestCanAsk', () => {
  it('is off (host-only) by default and for any unrecognized value', () => {
    expect(researchGuestCanAsk({})).toBe(false)
    expect(researchGuestCanAsk({ RESEARCH_GUEST_CAN_ASK: '0' })).toBe(false)
    expect(researchGuestCanAsk({ RESEARCH_GUEST_CAN_ASK: 'nope' })).toBe(false)
  })

  it('is on for 1/true/yes, case-insensitively', () => {
    expect(researchGuestCanAsk({ RESEARCH_GUEST_CAN_ASK: '1' })).toBe(true)
    expect(researchGuestCanAsk({ RESEARCH_GUEST_CAN_ASK: 'true' })).toBe(true)
    expect(researchGuestCanAsk({ RESEARCH_GUEST_CAN_ASK: 'YES' })).toBe(true)
  })
})

describe('setupWss — research assistant entries (per-tab, shared — see ADR-0002 and ticket 04)', () => {
  let wss, host, guest

  beforeEach(() => {
    _resetRooms()
    wss = mockWss()
    setupWss(wss)
    getActiveRoomBySlug.mockReturnValue({ slug: 'room1', password_hash: 'mock-hash' })
    host  = mockWs()
    guest = mockWs()
    wss.connect(host, 'room1', { asHost: true }); join(host, 'Host', 'c1')
    wss.connect(guest, 'room1');                  join(guest, 'Guest', 'c2')
  })

  function activeTabId(ws) {
    return latest(ws, 'tabs_state').activeTabId
  }

  it('a client can create a pending entry under the room\'s active tab — every peer receives it', () => {
    const tabId = activeTabId(host)
    host.sent.length = 0
    guest.sent.length = 0
    ask(host, { entryId: 'e1', question: 'What year did the moon landing happen?' })

    for (const ws of [host, guest]) {
      const msg = latest(ws, 'research_entry')
      expect(msg.tabId).toBe(tabId)
      expect(msg.entry).toMatchObject({
        id: 'e1',
        question: 'What year did the moon landing happen?',
        status: 'pending',
        answer: null,
        citations: []
      })
    }
  })

  it('a guest (non-host) cannot ask — refused with an error, no entry created or broadcast', () => {
    host.sent.length = 0
    guest.sent.length = 0
    ask(guest, { entryId: 'e1', question: 'Can a guest ask this?' })
    expect(guest.sent.some((m) => m.type === 'error')).toBe(true)
    expect(guest.sent.some((m) => m.type === 'research_entry')).toBe(false)
    expect(host.sent.some((m) => m.type === 'research_entry')).toBe(false)
  })

  it('RESEARCH_GUEST_CAN_ASK=true lets a guest ask and remove too', () => {
    process.env.RESEARCH_GUEST_CAN_ASK = 'true'
    try {
      const tabId = activeTabId(guest)
      host.sent.length = 0
      guest.sent.length = 0
      ask(guest, { entryId: 'e1', question: 'Can a guest ask now?' })

      for (const ws of [host, guest]) {
        expect(latest(ws, 'research_entry')).toMatchObject({ tabId, entry: { id: 'e1', status: 'pending' } })
      }

      host.sent.length = 0
      guest.sent.length = 0
      guest.emit('message', JSON.stringify({ type: 'research_remove', entryId: 'e1' }))
      for (const ws of [host, guest]) {
        expect(latest(ws, 'research_removed')).toEqual({ type: 'research_removed', tabId, entryId: 'e1' })
      }
    } finally {
      delete process.env.RESEARCH_GUEST_CAN_ASK
    }
  })

  it('rejects an empty question rather than creating or broadcasting an entry', () => {
    host.sent.length = 0
    ask(host, { entryId: 'e1', question: '   ' })
    expect(host.sent.some((m) => m.type === 'error')).toBe(true)
    expect(host.sent.some((m) => m.type === 'research_entry')).toBe(false)
  })

  it('an entry can be resolved to an answer — the update broadcasts to every peer', () => {
    ask(host, { entryId: 'e1', question: 'Define photosynthesis.' })
    host.sent.length = 0
    guest.sent.length = 0

    host.emit('message', JSON.stringify({
      type: 'research_resolve',
      entryId: 'e1',
      answer: 'Photosynthesis converts light into chemical energy.',
      citations: [{ url: 'https://example.com/photo', title: 'Photosynthesis basics' }]
    }))

    for (const ws of [host, guest]) {
      const msg = latest(ws, 'research_entry')
      expect(msg.entry).toMatchObject({
        id: 'e1',
        status: 'answered',
        answer: 'Photosynthesis converts light into chemical energy.',
        citations: [{ url: 'https://example.com/photo', title: 'Photosynthesis basics' }]
      })
    }
  })

  it('an entry can be errored — the update broadcasts to every peer, never leaving it stuck pending', () => {
    ask(host, { entryId: 'e1', question: 'Define photosynthesis.' })
    host.sent.length = 0
    guest.sent.length = 0

    host.emit('message', JSON.stringify({
      type: 'research_error',
      entryId: 'e1',
      message: 'The Research Assistant could not be reached.'
    }))

    for (const ws of [host, guest]) {
      const msg = latest(ws, 'research_entry')
      expect(msg.entry).toMatchObject({
        id: 'e1',
        status: 'errored',
        answer: null,
        error: 'The Research Assistant could not be reached.'
      })
    }
  })

  it('resolving/erroring an unknown entry id is refused to the sender only, without broadcasting anything', () => {
    host.sent.length = 0
    guest.sent.length = 0
    host.emit('message', JSON.stringify({ type: 'research_resolve', entryId: 'nope', answer: 'x' }))
    expect(host.sent.some((m) => m.type === 'error')).toBe(true)
    expect(guest.sent.some((m) => m.type === 'research_entry')).toBe(false)
  })

  it('entries created while one tab is active are filed strictly under that tab, never leaking into another tab', () => {
    const firstTabId = activeTabId(host)
    ask(host, { entryId: 'e1', question: 'Question for tab 1' })

    // Create and switch to a second tab — the room's active tab changes.
    host.emit('message', JSON.stringify({ type: 'tab_create', tabId: 'tab-2' }))
    expect(activeTabId(host)).toBe('tab-2')

    ask(host, { entryId: 'e2', question: 'Question for tab 2' })

    // A resync replays each tab's own accumulated history separately.
    host.sent.length = 0
    host.emit('message', JSON.stringify({ type: 'tabs_sync' }))
    const states = host.sent.filter((m) => m.type === 'research_state')
    const byTab = Object.fromEntries(states.map((s) => [s.tabId, s.entries.map((e) => e.id)]))
    expect(byTab[firstTabId]).toEqual(['e1'])
    expect(byTab['tab-2']).toEqual(['e2'])
  })

  it('a (re)joining/resyncing client is replayed each tab\'s accumulated entries, before any new live entry', () => {
    const tabId = activeTabId(host)
    ask(host, { entryId: 'e1', question: 'Earlier question?' })
    guest.emit('close') // free a slot — room is capped at MAX_PEERS

    const late = mockWs()
    wss.connect(late, 'room1'); join(late, 'Late', 'c3')
    const replay = latest(late, 'research_state')
    expect(replay).toEqual({ type: 'research_state', tabId, entries: [expect.objectContaining({ id: 'e1' })] })

    ask(host, { entryId: 'e2', question: 'New live question?' })
    expect(latest(late, 'research_entry').entry.id).toBe('e2')
  })

  it('a client can remove an entry outright — every peer including the sender is told', () => {
    const tabId = activeTabId(host)
    ask(host, { entryId: 'e1', question: 'Define photosynthesis.' })
    host.sent.length = 0
    guest.sent.length = 0

    host.emit('message', JSON.stringify({ type: 'research_remove', entryId: 'e1' }))

    for (const ws of [host, guest]) {
      expect(latest(ws, 'research_removed')).toEqual({ type: 'research_removed', tabId, entryId: 'e1' })
    }

    // A resync no longer replays the removed entry.
    host.sent.length = 0
    host.emit('message', JSON.stringify({ type: 'tabs_sync' }))
    expect(host.sent.some((m) => m.type === 'research_state')).toBe(false)
  })

  it('a guest (non-host) cannot remove an entry — refused with an error, nothing removed or broadcast', () => {
    ask(host, { entryId: 'e1', question: 'Define photosynthesis.' })
    host.sent.length = 0
    guest.sent.length = 0

    guest.emit('message', JSON.stringify({ type: 'research_remove', entryId: 'e1' }))

    expect(guest.sent.some((m) => m.type === 'error')).toBe(true)
    expect(guest.sent.some((m) => m.type === 'research_removed')).toBe(false)
    expect(host.sent.some((m) => m.type === 'research_removed')).toBe(false)
  })

  it('removing an unknown entry id is refused to the sender only, without broadcasting anything', () => {
    host.sent.length = 0
    guest.sent.length = 0
    host.emit('message', JSON.stringify({ type: 'research_remove', entryId: 'nope' }))
    expect(host.sent.some((m) => m.type === 'error')).toBe(true)
    expect(guest.sent.some((m) => m.type === 'research_removed')).toBe(false)
  })

  it('research history survives the last peer disconnecting and rejoining, replayed in full on rejoin', () => {
    const tabId = activeTabId(host)
    ask(host, { entryId: 'e1', question: 'keep me' })
    host.emit('close')
    guest.emit('close')

    const again = mockWs()
    wss.connect(again, 'room1'); join(again, 'Host', 'c1')
    const replay = latest(again, 'research_state')
    expect(replay).toEqual({ type: 'research_state', tabId, entries: [expect.objectContaining({ id: 'e1', question: 'keep me' })] })
  })
})
