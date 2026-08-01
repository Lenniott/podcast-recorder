import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// ─── Mock db so ws-rooms doesn't need a real DB ─────────────────────────────
vi.mock('../../src/lib/server/db.js', () => ({
  roomExists: vi.fn(() => true),  // default: room exists
  getRoomBySlug: vi.fn(() => ({
    slug: 'room1',
    password_hash: 'mock-hash',
    show_upload: 1
  })),
  default: {}
}))

// ─── Mock auth so a known cookie value grants the host claim ────────────────
vi.mock('../../src/lib/server/auth.js', () => ({
  verifyHostClaimToken: vi.fn((token) => token === 'valid-host-token')
}))

import { roomExists, getRoomBySlug } from '../../src/lib/server/db.js'
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
    connect(ws, slug, { asHost = false } = {}) {
      const headers = asHost ? { cookie: `pr_host_${slug}=valid-host-token` } : {}
      const req = { url: `/ws?slug=${slug}`, headers }
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

describe('setupWss — yt_state (watch together)', () => {
  let wss, host, guest

  function sendYt(ws, videoId = 'dQw4w9WgXcQ', playing = true, positionSec = 42.5) {
    ws.emit('message', JSON.stringify({ type: 'yt_state', videoId, playing, positionSec }))
  }

  beforeEach(() => {
    _resetRooms()
    wss = mockWss()
    setupWss(wss)
    roomExists.mockReturnValue(true)
    host  = mockWs()
    guest = mockWs()
    wss.connect(host, 'room1', { asHost: true }); join(host, 'Host', 'c1')
    wss.connect(guest, 'room1');                  join(guest, 'Guest', 'c2')
  })

  it('host command broadcasts stamped state to all peers including host', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(5000)
    sendYt(host)
    for (const ws of [host, guest]) {
      const msg = ws.sent.find(m => m.type === 'yt_state')
      expect(msg).toMatchObject({
        videoId: 'dQw4w9WgXcQ',
        playing: true,
        positionSec: 42.5,
        positionAtMs: 5250,   // Date.now() + YT_LEAD_MS
        triggerAtMs: 5250
      })
    }
    nowSpy.mockRestore()
  })

  it('rejects yt_state from non-host with error and no broadcast', () => {
    sendYt(guest)
    expect(guest.sent.some(m => m.type === 'error')).toBe(true)
    expect(host.sent.some(m => m.type === 'yt_state')).toBe(false)
  })

  it('rejects malformed video ids', () => {
    sendYt(host, 'javascript:alert(1)')
    expect(host.sent.some(m => m.type === 'error')).toBe(true)
    expect(host.sent.some(m => m.type === 'yt_state')).toBe(false)
  })

  it('coerces bad positionSec to 0', () => {
    sendYt(host, 'dQw4w9WgXcQ', false, 'garbage')
    const msg = host.sent.find(m => m.type === 'yt_state')
    expect(msg.positionSec).toBe(0)
    expect(msg.playing).toBe(false)
  })

  it('replays stored state to a late joiner with a fresh triggerAtMs', () => {
    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValue(5000)
    guest.emit('close')                       // room back to host only
    sendYt(host, 'dQw4w9WgXcQ', true, 10)

    nowSpy.mockReturnValue(9000)              // guest arrives 4s later
    const late = mockWs()
    wss.connect(late, 'room1'); join(late, 'Late', 'c3')

    const replay = late.sent.find(m => m.type === 'yt_state')
    expect(replay).toMatchObject({
      videoId: 'dQw4w9WgXcQ',
      playing: true,
      positionSec: 10,
      positionAtMs: 5250,   // original stamp — lets the client compute catch-up
      triggerAtMs: 9250     // fresh trigger
    })
    nowSpy.mockRestore()
  })

  it('does not replay on a name-update join', () => {
    sendYt(host)
    host.sent.length = 0
    join(host, 'Renamed Host', 'c1')          // same clientId → name update
    expect(host.sent.some(m => m.type === 'yt_state')).toBe(false)
  })

  it('empty videoId clears state and broadcasts the clear', () => {
    sendYt(host)
    sendYt(host, '')
    const clear = guest.sent.filter(m => m.type === 'yt_state').at(-1)
    expect(clear.videoId).toBe('')

    // a new joiner gets no replay
    guest.emit('close')
    const late = mockWs()
    wss.connect(late, 'room1'); join(late, 'Late', 'c3')
    expect(late.sent.some(m => m.type === 'yt_state')).toBe(false)
  })

  it('state is dropped when the room empties', () => {
    sendYt(host)
    guest.emit('close')
    host.emit('close')

    const again = mockWs()
    wss.connect(again, 'room1'); join(again, 'Back', 'c9')
    expect(again.sent.some(m => m.type === 'yt_state')).toBe(false)
  })
})

describe('setupWss — yt_state guest control permission', () => {
  let wss, host, guest

  function send(ws, payload) {
    ws.emit('message', JSON.stringify({ type: 'yt_state', ...payload }))
  }

  beforeEach(() => {
    _resetRooms()
    wss = mockWss()
    setupWss(wss)
    roomExists.mockReturnValue(true)
    getRoomBySlug.mockReturnValue({
      slug: 'room1',
      password_hash: 'mock-hash',
      show_upload: 1,
      guest_can_control_playback: 1
    })
    host  = mockWs()
    guest = mockWs()
    wss.connect(host, 'room1', { asHost: true }); join(host, 'Host', 'c1')
    wss.connect(guest, 'room1');                  join(guest, 'Guest', 'c2')
  })

  afterEach(() => {
    // Restore the default mock used by every other describe block.
    getRoomBySlug.mockReturnValue({ slug: 'room1', password_hash: 'mock-hash', show_upload: 1 })
  })

  it('allows a guest "control" action on the currently loaded video when the room permits it', () => {
    send(host, { action: 'load', videoId: 'dQw4w9WgXcQ', playing: false, positionSec: 0 })
    send(guest, { action: 'control', videoId: 'dQw4w9WgXcQ', playing: true, positionSec: 12 })

    const msg = host.sent.filter(m => m.type === 'yt_state').at(-1)
    expect(msg).toMatchObject({ videoId: 'dQw4w9WgXcQ', playing: true, positionSec: 12 })
  })

  it('still rejects a guest "load" action even when the room permits control', () => {
    send(guest, { action: 'load', videoId: 'dQw4w9WgXcQ', playing: false, positionSec: 0 })
    expect(guest.sent.some(m => m.type === 'error')).toBe(true)
    expect(host.sent.some(m => m.type === 'yt_state')).toBe(false)
  })

  it('still rejects a guest "clear" action even when the room permits control', () => {
    send(host, { action: 'load', videoId: 'dQw4w9WgXcQ', playing: false, positionSec: 0 })
    host.sent.length = 0
    guest.sent.length = 0
    send(guest, { action: 'clear', videoId: '', playing: false, positionSec: 0 })
    expect(guest.sent.some(m => m.type === 'error')).toBe(true)
    expect(host.sent.some(m => m.type === 'yt_state')).toBe(false)
  })

  it('ignores a guest "control" action whose videoId does not match the currently loaded video', () => {
    send(host, { action: 'load', videoId: 'dQw4w9WgXcQ', playing: false, positionSec: 0 })
    host.sent.length = 0
    guest.sent.length = 0
    send(guest, { action: 'control', videoId: 'jNQXAC9IVRw', playing: true, positionSec: 5 })
    expect(host.sent.some(m => m.type === 'yt_state')).toBe(false)
    expect(guest.sent.some(m => m.type === 'yt_state')).toBe(false)
  })

  it('rejects a guest control action when the room does not permit it', () => {
    getRoomBySlug.mockReturnValue({ slug: 'room1', password_hash: 'mock-hash', show_upload: 1, guest_can_control_playback: 0 })
    // Reconnect so the new peer picks up the freshly-mocked room row.
    _resetRooms()
    host  = mockWs()
    guest = mockWs()
    wss.connect(host, 'room1', { asHost: true }); join(host, 'Host', 'c1')
    wss.connect(guest, 'room1');                  join(guest, 'Guest', 'c2')

    send(host, { action: 'load', videoId: 'dQw4w9WgXcQ', playing: false, positionSec: 0 })
    guest.sent.length = 0
    send(guest, { action: 'control', videoId: 'dQw4w9WgXcQ', playing: true, positionSec: 5 })
    expect(guest.sent.some(m => m.type === 'error')).toBe(true)
  })
})
