import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// ─── Mock db so ws-rooms doesn't need a real DB ─────────────────────────────
vi.mock('../../src/lib/server/db.js', () => ({
  getActiveRoomBySlug: vi.fn(() => ({
    slug: 'room1',
    password_hash: 'mock-hash',
    guest_ai_allowed: 0,
    friend_room: 1
  })),
  getCustomPrompt: vi.fn(),
  recordResearchUsage: vi.fn(),
  default: {}
}))

vi.mock('../../src/lib/server/auth.js', () => ({
  getHostClaim: vi.fn((slug, cookies, room) => !!room && cookies.get(`pr_host_${slug}`) === 'valid-host-token'),
  verifySessionToken: vi.fn((token, slug) => token === 'valid-session-token'),
  makeServerCopyToken: vi.fn((slug, clientId) => `token:${slug}:${clientId}`)
}))

vi.mock('../../src/lib/server/research-eval-log.js', () => ({
  appendResearchEvalLog: vi.fn()
}))

import { getActiveRoomBySlug, getCustomPrompt } from '../../src/lib/server/db.js'
import { setupWss, _resetRooms } from '../../src/lib/server/ws-rooms.js'
import { mockWs, mockWss, join } from './ws-test-helpers.js'

// Friend rooms must never spend a real Research Assistant call — same
// guard ws-annotation-ask.test.js uses.
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => {
    throw new Error('A Friend-room test tried to make a real network call to the Research Assistant.')
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function latest(ws, type) {
  return ws.sent.filter((m) => m.type === type).at(-1)
}

describe('Friend room — Research Assistant/AI is unconditionally off (friend-password-auth, ticket 02)', () => {
  let wss, host, guest

  beforeEach(() => {
    _resetRooms()
    wss = mockWss()
    setupWss(wss)
    getActiveRoomBySlug.mockReturnValue({
      slug: 'room1',
      password_hash: 'mock-hash',
      guest_ai_allowed: 0,
      friend_room: 1
    })
    host  = mockWs()
    guest = mockWs()
    // `host` here holds the room's own host claim — for a Friend-created
    // room this is the Friend who created it. It must NOT bypass the AI
    // gate the way a Host room's own host claim does (see ws-research.test.js).
    wss.connect(host, 'room1', { asHost: true }); join(host, 'Host', 'c1')
    wss.connect(guest, 'room1');                  join(guest, 'Guest', 'c2')
  })

  it("rejects research_ask from the room's own host claim", () => {
    host.sent.length = 0
    host.emit('message', JSON.stringify({ type: 'research_ask', entryId: 'e1', question: 'Can the room host ask?' }))
    expect(host.sent.some((m) => m.type === 'error')).toBe(true)
    expect(host.sent.some((m) => m.type === 'research_entry')).toBe(false)
  })

  it('rejects research_ask from a guest too', () => {
    guest.sent.length = 0
    guest.emit('message', JSON.stringify({ type: 'research_ask', entryId: 'e1', question: 'Can a guest ask?' }))
    expect(guest.sent.some((m) => m.type === 'error')).toBe(true)
    expect(guest.sent.some((m) => m.type === 'research_entry')).toBe(false)
  })

  it('rejects research_prompt_ask from the room host claim', () => {
    getCustomPrompt.mockReturnValue({ id: 'cp1', title: 'Recap', prompt: 'Summarize {transcript}.' })
    host.sent.length = 0
    host.emit('message', JSON.stringify({ type: 'research_prompt_ask', entryId: 'e1', customPromptId: 'cp1' }))
    expect(host.sent.some((m) => m.type === 'error')).toBe(true)
    expect(host.sent.some((m) => m.type === 'research_entry')).toBe(false)
  })

  it('rejects research_remove from the room host claim', () => {
    host.sent.length = 0
    host.emit('message', JSON.stringify({ type: 'research_remove', entryId: 'whatever' }))
    expect(host.sent.some((m) => m.type === 'error')).toBe(true)
    expect(host.sent.some((m) => m.type === 'research_removed')).toBe(false)
  })

  it('rejects annotation_ask (a Custom Prompt run from a highlight) from the room host claim', () => {
    getCustomPrompt.mockReturnValue({ id: 'cp1', title: 'Fact check', prompt: 'Fact-check {selection}.' })
    host.sent.length = 0
    host.emit('message', JSON.stringify({
      type: 'annotation_ask',
      id: 'a1',
      tabId: latest(host, 'tabs_state')?.activeTabId,
      customPromptId: 'cp1',
      quote: 'something said'
    }))
    expect(host.sent.some((m) => m.type === 'error')).toBe(true)
    expect(host.sent.some((m) => m.type === 'annotation_entry')).toBe(false)
  })

  it('still allows a plain Comment (annotation_create), which is not gated by AI eligibility', () => {
    const tabId = latest(host, 'tabs_state').activeTabId
    host.sent.length = 0
    host.emit('message', JSON.stringify({ type: 'annotation_create', id: 'c1', tabId, kind: 'comment', quote: 'q', text: 'a human note' }))
    expect(latest(host, 'annotation_entry')).toMatchObject({ tabId, entry: { id: 'c1', kind: 'comment' } })
  })
})

describe('Host room (friend_room: 0) — unaffected by the Friend-room AI override', () => {
  let wss, host

  beforeEach(() => {
    _resetRooms()
    wss = mockWss()
    setupWss(wss)
    getActiveRoomBySlug.mockReturnValue({
      slug: 'room1',
      password_hash: 'mock-hash',
      guest_ai_allowed: 0,
      friend_room: 0
    })
    host = mockWs()
    wss.connect(host, 'room1', { asHost: true }); join(host, 'Host', 'c1')
  })

  it('still lets the room host ask, exactly as before this ticket', () => {
    const tabId = latest(host, 'tabs_state').activeTabId
    host.sent.length = 0
    host.emit('message', JSON.stringify({ type: 'research_ask', entryId: 'e1', question: 'Still works?' }))
    expect(latest(host, 'research_entry')).toMatchObject({ tabId, entry: { id: 'e1', status: 'pending' } })
  })
})
