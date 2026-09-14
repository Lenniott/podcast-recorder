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
import { setupWss, _resetRooms } from '../../src/lib/server/ws-rooms.js'
import { mockWs, mockWss, join } from './ws-test-helpers.js'

function latest(ws, type) {
  return ws.sent.filter((m) => m.type === type).at(-1)
}

describe('setupWss — transcript (append-only, ADR-0002)', () => {
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

  it('replays an empty transcript to a brand-new room on join', () => {
    expect(latest(host, 'transcript_state')).toEqual({ type: 'transcript_state', lines: [] })
  })

  it('a client can send one new transcript line — every connected peer receives it, speaker-labeled', () => {
    host.sent.length = 0
    guest.sent.length = 0
    host.emit('message', JSON.stringify({ type: 'transcript_line', speaker: 'Host', text: 'Hello everyone.' }))

    for (const ws of [host, guest]) {
      const line = latest(ws, 'transcript_line')
      expect(line).toMatchObject({ type: 'transcript_line', speaker: 'Host', text: 'Hello everyone.' })
      expect(typeof line.id).toBe('string')
      expect(typeof line.at).toBe('number')
    }
  })

  it('two lines sent at nearly the same instant from two different participants both land, in a stable order, nothing dropped', () => {
    host.sent.length = 0
    guest.sent.length = 0
    host.emit('message', JSON.stringify({ type: 'transcript_line', speaker: 'Host', text: 'First.' }))
    guest.emit('message', JSON.stringify({ type: 'transcript_line', speaker: 'Guest', text: 'Second.' }))

    const hostLines = host.sent.filter((m) => m.type === 'transcript_line')
    const guestLines = guest.sent.filter((m) => m.type === 'transcript_line')
    expect(hostLines.map((l) => l.text)).toEqual(['First.', 'Second.'])
    expect(guestLines.map((l) => l.text)).toEqual(['First.', 'Second.'])
  })

  it('rejects an empty transcript line rather than appending or broadcasting it', () => {
    host.sent.length = 0
    host.emit('message', JSON.stringify({ type: 'transcript_line', speaker: 'Host', text: '   ' }))
    expect(host.sent.some((m) => m.type === 'error')).toBe(true)
    expect(host.sent.some((m) => m.type === 'transcript_line')).toBe(false)
  })

  it('a client that requests a resync (tabs_sync) is replayed the full transcript-so-far, in order, before any new live line', () => {
    host.emit('message', JSON.stringify({ type: 'transcript_line', speaker: 'Host', text: 'One.' }))
    guest.emit('message', JSON.stringify({ type: 'transcript_line', speaker: 'Guest', text: 'Two.' }))
    host.sent.length = 0
    host.emit('message', JSON.stringify({ type: 'tabs_sync' }))
    expect(latest(host, 'transcript_state').lines.map((l) => l.text)).toEqual(['One.', 'Two.'])
  })

  it('a late joiner is replayed the full transcript before any new live line arrives', () => {
    host.emit('message', JSON.stringify({ type: 'transcript_line', speaker: 'Host', text: 'Earlier line.' }))
    guest.emit('close') // free a slot — room is capped at MAX_PEERS

    const late = mockWs()
    wss.connect(late, 'room1'); join(late, 'Late', 'c3')
    expect(latest(late, 'transcript_state').lines.map((l) => l.text)).toEqual(['Earlier line.'])

    host.emit('message', JSON.stringify({ type: 'transcript_line', speaker: 'Host', text: 'New live line.' }))
    expect(latest(late, 'transcript_line').text).toBe('New live line.')
  })

  it('transcript survives the last peer disconnecting and rejoining, replayed in full on rejoin', () => {
    host.emit('message', JSON.stringify({ type: 'transcript_line', speaker: 'Host', text: 'keep me' }))
    host.emit('close')
    guest.emit('close')

    const again = mockWs()
    wss.connect(again, 'room1'); join(again, 'Host', 'c1')
    expect(latest(again, 'transcript_state').lines.map((l) => l.text)).toEqual(['keep me'])
  })
})
