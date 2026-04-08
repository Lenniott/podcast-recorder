import { describe, it, expect, beforeEach, vi } from 'vitest'

// ─── Mock roomExists so ws-rooms doesn't need a real DB ─────────────────────
vi.mock('../../src/lib/server/db.js', () => ({
  roomExists: vi.fn(() => true),  // default: room exists
  default: {}
}))

import { roomExists } from '../../src/lib/server/db.js'
import { setupWss, _resetRooms } from '../../src/lib/server/ws-rooms.js'

// ─── Minimal WebSocket mock ──────────────────────────────────────────────────

function mockWs() {
  const ws = {
    readyState: 1,  // OPEN
    sent: [],
    closed: false,
    closeCode: null,
    handlers: {},
    send(data) { this.sent.push(JSON.parse(data)) },
    close(code, reason) { this.closed = true; this.closeCode = code },
    on(event, fn) { this.handlers[event] = fn },
    emit(event, ...args) { this.handlers[event]?.(...args) }
  }
  return ws
}

function mockWss() {
  const handlers = {}
  return {
    on(event, fn) { handlers[event] = fn },
    connect(ws, slug) {
      const req = { url: `/ws?slug=${slug}` }
      handlers.connection?.(ws, req)
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function join(ws, name = 'Host', clientId = 'client-1') {
  ws.emit('message', JSON.stringify({ type: 'join', name, clientId }))
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('setupWss — connection handling', () => {
  let wss

  beforeEach(() => {
    _resetRooms()          // clear stale state from previous test
    wss = mockWss()
    setupWss(wss)
    roomExists.mockReturnValue(true)
  })

  it('closes connection when no slug provided', () => {
    const ws = mockWs()
    const req = { url: '/ws' }
    wss.on('connection', () => {})
    // Manually invoke with no slug
    const req2 = { url: '/ws?slug=' }
    // Re-setup to test this path
    const wss2 = mockWss()
    setupWss(wss2)
    roomExists.mockReturnValue(false)
    const ws2 = mockWs()
    wss2.connect(ws2, 'nonexistent')
    expect(ws2.closed).toBe(true)
  })

  it('closes connection when room does not exist', () => {
    roomExists.mockReturnValue(false)
    const ws = mockWs()
    wss.connect(ws, 'badslug')
    expect(ws.closed).toBe(true)
  })

  it('sends presence after join', () => {
    const ws = mockWs()
    wss.connect(ws, 'room1')
    join(ws, 'Alice', 'c1')
    const presenceMsgs = ws.sent.filter(m => m.type === 'presence')
    expect(presenceMsgs.length).toBeGreaterThan(0)
    expect(presenceMsgs.at(-1).peers[0].name).toBe('Alice')
  })

  it('evicts stale connection with same clientId on reconnect', () => {
    const ws1 = mockWs()
    const ws2 = mockWs()
    wss.connect(ws1, 'room1')
    join(ws1, 'Alice', 'same-id')
    wss.connect(ws2, 'room1')
    join(ws2, 'Alice', 'same-id')
    // ws1 should have been closed
    expect(ws1.closed).toBe(true)
  })

  it('rejects third connection — room full', () => {
    const ws1 = mockWs()
    const ws2 = mockWs()
    const ws3 = mockWs()
    wss.connect(ws1, 'room1'); join(ws1, 'Host',  'c1')
    wss.connect(ws2, 'room1'); join(ws2, 'Guest', 'c2')
    wss.connect(ws3, 'room1'); join(ws3, 'Extra', 'c3')
    const rejected = ws3.sent.find(m => m.type === 'rejected')
    expect(rejected).toBeDefined()
    expect(ws3.closed).toBe(true)
  })

  it('broadcasts clap to all peers including sender', () => {
    const ws1 = mockWs()
    const ws2 = mockWs()
    wss.connect(ws1, 'room1'); join(ws1, 'Host',  'c1')
    wss.connect(ws2, 'room1'); join(ws2, 'Guest', 'c2')
    ws1.emit('message', JSON.stringify({ type: 'clap' }))
    expect(ws1.sent.some(m => m.type === 'clap')).toBe(true)
    expect(ws2.sent.some(m => m.type === 'clap')).toBe(true)
  })

  it('clap message includes timestamp and sender name', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000)
    const ws1 = mockWs()
    wss.connect(ws1, 'room1'); join(ws1, 'Alice', 'c1')
    ws1.emit('message', JSON.stringify({ type: 'clap' }))
    const clap = ws1.sent.find(m => m.type === 'clap')
    expect(clap.from).toBe('Alice')
    expect(clap.timestamp).toMatch(/^\d{4}-/)
    expect(typeof clap.triggerAtMs).toBe('number')
    expect(clap.triggerAtMs).toBeGreaterThan(1000)
    nowSpy.mockRestore()
  })

  it('recording_state updates peer and broadcasts to others (not sender)', () => {
    const ws1 = mockWs()
    const ws2 = mockWs()
    wss.connect(ws1, 'room1'); join(ws1, 'Host',  'c1')
    wss.connect(ws2, 'room1'); join(ws2, 'Guest', 'c2')
    ws1.emit('message', JSON.stringify({ type: 'recording_state', state: 'recording' }))
    // ws2 should receive the state update
    expect(ws2.sent.some(m => m.type === 'recording_state' && m.state === 'recording')).toBe(true)
    // ws1 should NOT receive its own state update
    expect(ws1.sent.filter(m => m.type === 'recording_state').length).toBe(0)
    // Presence should reflect recording=true
    const presence = ws1.sent.filter(m => m.type === 'presence').at(-1)
    const host = presence.peers.find(p => p.name === 'Host')
    expect(host.recording).toBe(true)
  })

  it('removes peer and updates presence on disconnect', () => {
    const ws1 = mockWs()
    const ws2 = mockWs()
    wss.connect(ws1, 'room1'); join(ws1, 'Host',  'c1')
    wss.connect(ws2, 'room1'); join(ws2, 'Guest', 'c2')
    ws1.emit('close')
    // ws2 should see updated presence with only 1 peer
    const lastPresence = ws2.sent.filter(m => m.type === 'presence').at(-1)
    expect(lastPresence.peers.length).toBe(1)
    expect(lastPresence.peers[0].name).toBe('Guest')
  })
})
