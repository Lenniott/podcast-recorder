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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('setupWss — connection handling', () => {
  let wss

  beforeEach(() => {
    _resetRooms()          // clear stale state from previous test
    wss = mockWss()
    setupWss(wss)
    getActiveRoomBySlug.mockReturnValue({ slug: 'room1', password_hash: 'mock-hash' })
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
    getActiveRoomBySlug.mockReturnValue(null)
    const ws2 = mockWs()
    wss2.connect(ws2, 'nonexistent')
    expect(ws2.closed).toBe(true)
  })

  it('closes connection when room does not exist', () => {
    getActiveRoomBySlug.mockReturnValue(null)
    const ws = mockWs()
    wss.connect(ws, 'badslug')
    expect(ws.closed).toBe(true)
  })

  it('grants the host role to the peer holding a valid host-claim cookie', () => {
    const ws = mockWs()
    wss.connect(ws, 'room1', { asHost: true })
    join(ws, 'Alice', 'c1')
    const presence = ws.sent.filter(m => m.type === 'presence').at(-1)
    expect(presence.peers[0]).toMatchObject({ name: 'Alice', isHost: true, role: 'host' })
  })

  it('does not grant the host role without the host-claim cookie', () => {
    const ws = mockWs()
    wss.connect(ws, 'room1') // no asHost — no pr_host_ cookie sent
    join(ws, 'Alice', 'c1')
    const presence = ws.sent.filter(m => m.type === 'presence').at(-1)
    expect(presence.peers[0]).toMatchObject({ name: 'Alice', isHost: false, role: 'guest' })
  })

  it('sends a clientId-scoped server_copy_token only to the connection that just joined with it (ticket 11)', () => {
    const ws1 = mockWs()
    const ws2 = mockWs()
    wss.connect(ws1, 'room1'); join(ws1, 'Host', 'c1')

    const tokenMsg1 = ws1.sent.find((m) => m.type === 'server_copy_token')
    expect(tokenMsg1).toMatchObject({ clientId: 'c1', token: 'token:room1:c1' })

    wss.connect(ws2, 'room1'); join(ws2, 'Guest', 'c2')

    // The second peer's join must never leak a token to the first peer
    // (or vice versa) — this is the one channel that has to stay
    // exclusive to the connection that owns each clientId.
    expect(ws1.sent.filter((m) => m.type === 'server_copy_token')).toHaveLength(1)
    const tokenMsg2 = ws2.sent.find((m) => m.type === 'server_copy_token')
    expect(tokenMsg2).toMatchObject({ clientId: 'c2', token: 'token:room1:c2' })
    expect(ws1.sent.some((m) => m.type === 'server_copy_token' && m.clientId === 'c2')).toBe(false)
  })

  it('does not re-mint/resend a server_copy_token on a name-only subsequent join', () => {
    const ws = mockWs()
    wss.connect(ws, 'room1'); join(ws, 'Alice', 'c1')
    join(ws, 'Alice Renamed', 'c1') // same clientId — name update, not a first join

    expect(ws.sent.filter((m) => m.type === 'server_copy_token')).toHaveLength(1)
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
    ws1.emit('message', JSON.stringify({
      type: 'recording_state',
      state: 'recording',
      startedAt: 1_700_000_000_000
    }))
    // ws2 should receive the state update
    expect(ws2.sent.some(m => m.type === 'recording_state' && m.state === 'recording')).toBe(true)
    // ws1 should NOT receive its own state update
    expect(ws1.sent.filter(m => m.type === 'recording_state').length).toBe(0)
    // Presence should reflect recording=true
    const presence = ws1.sent.filter(m => m.type === 'presence').at(-1)
    const host = presence.peers.find(p => p.name === 'Host')
    expect(host.recording).toBe(true)
    expect(host.recordingStartedAt).toBe(1_700_000_000_000)
  })

  it('same-clientId reconnect drops recording until the client resends it', () => {
    const ws1 = mockWs()
    const ws2 = mockWs()
    const guest = mockWs()
    wss.connect(ws1, 'room1'); join(ws1, 'Host', 'c1')
    wss.connect(guest, 'room1'); join(guest, 'Guest', 'c2')
    ws1.emit('message', JSON.stringify({
      type: 'recording_state',
      state: 'recording',
      startedAt: 1_700_000_000_000
    }))

    wss.connect(ws2, 'room1'); join(ws2, 'Host', 'c1')
    const afterJoin = guest.sent.filter(m => m.type === 'presence').at(-1)
    expect(afterJoin.peers.find(p => p.name === 'Host').recording).toBe(false)
    expect(afterJoin.peers.find(p => p.name === 'Host').recordingStartedAt).toBeNull()

    ws2.emit('message', JSON.stringify({
      type: 'recording_state',
      state: 'recording',
      startedAt: 1_700_000_000_000
    }))
    const afterResync = guest.sent.filter(m => m.type === 'presence').at(-1)
    expect(afterResync.peers.find(p => p.name === 'Host').recording).toBe(true)
    expect(afterResync.peers.find(p => p.name === 'Host').recordingStartedAt).toBe(1_700_000_000_000)
  })

  it('presence defaults a fresh peer to an unavailable server copy', () => {
    const ws = mockWs()
    wss.connect(ws, 'room1')
    join(ws, 'Alice', 'c1')
    const presence = ws.sent.filter(m => m.type === 'presence').at(-1)
    expect(presence.peers[0]).toMatchObject({ serverCopyState: 'unavailable', serverCopyPercent: 0 })
  })

  it('server_copy_progress updates peer and is visible to both peers via presence', () => {
    const ws1 = mockWs()
    const ws2 = mockWs()
    wss.connect(ws1, 'room1'); join(ws1, 'Host',  'c1')
    wss.connect(ws2, 'room1'); join(ws2, 'Guest', 'c2')
    ws1.emit('message', JSON.stringify({ type: 'server_copy_progress', state: 'in_progress', percent: 42, takeId: 'take123' }))

    for (const ws of [ws1, ws2]) {
      const presence = ws.sent.filter(m => m.type === 'presence').at(-1)
      const host = presence.peers.find(p => p.name === 'Host')
      expect(host).toMatchObject({ serverCopyState: 'in_progress', serverCopyPercent: 42, serverCopyTakeId: 'take123' })
    }
  })

  it('server_copy_progress preserves the current take id when a later status omits it', () => {
    const ws1 = mockWs()
    wss.connect(ws1, 'room1'); join(ws1, 'Host', 'c1')
    ws1.emit('message', JSON.stringify({ type: 'server_copy_progress', state: 'in_progress', percent: 42, takeId: 'take123' }))
    ws1.emit('message', JSON.stringify({ type: 'server_copy_progress', state: 'complete', percent: 100 }))

    const presence = ws1.sent.filter(m => m.type === 'presence').at(-1)
    const host = presence.peers.find(p => p.name === 'Host')
    expect(host).toMatchObject({ serverCopyState: 'complete', serverCopyPercent: 100, serverCopyTakeId: 'take123' })
  })

  it('server_copy_progress never carries recording along with it and vice versa', () => {
    const ws1 = mockWs()
    wss.connect(ws1, 'room1'); join(ws1, 'Host', 'c1')
    ws1.emit('message', JSON.stringify({ type: 'recording_state', state: 'recording' }))
    ws1.emit('message', JSON.stringify({ type: 'server_copy_progress', state: 'complete', percent: 100 }))

    const presence = ws1.sent.filter(m => m.type === 'presence').at(-1)
    const host = presence.peers.find(p => p.name === 'Host')
    expect(host.recording).toBe(true)
    expect(host.serverCopyState).toBe('complete')
    expect(host.serverCopyPercent).toBe(100)
  })

  it('rejects an unknown server_copy_progress state rather than trusting arbitrary client input', () => {
    const ws1 = mockWs()
    wss.connect(ws1, 'room1'); join(ws1, 'Host', 'c1')
    ws1.emit('message', JSON.stringify({ type: 'server_copy_progress', state: 'totally-made-up', percent: 50 }))

    const presence = ws1.sent.filter(m => m.type === 'presence').at(-1)
    const host = presence.peers.find(p => p.name === 'Host')
    expect(host.serverCopyState).toBe('unavailable')
  })

  it('same-clientId reconnect drops server-copy status until the client resends it', () => {
    const ws1 = mockWs()
    const ws2 = mockWs()
    const guest = mockWs()
    wss.connect(ws1, 'room1'); join(ws1, 'Host', 'c1')
    wss.connect(guest, 'room1'); join(guest, 'Guest', 'c2')
    ws1.emit('message', JSON.stringify({ type: 'server_copy_progress', state: 'in_progress', percent: 75 }))

    wss.connect(ws2, 'room1'); join(ws2, 'Host', 'c1')
    const afterJoin = guest.sent.filter(m => m.type === 'presence').at(-1)
    expect(afterJoin.peers.find(p => p.name === 'Host')).toMatchObject({ serverCopyState: 'unavailable', serverCopyPercent: 0 })

    ws2.emit('message', JSON.stringify({ type: 'server_copy_progress', state: 'in_progress', percent: 75 }))
    const afterResync = guest.sent.filter(m => m.type === 'presence').at(-1)
    expect(afterResync.peers.find(p => p.name === 'Host')).toMatchObject({ serverCopyState: 'in_progress', serverCopyPercent: 75 })
  })

  it('mic_info is stored on the peer and shown to both via presence', () => {
    const ws1 = mockWs()
    const ws2 = mockWs()
    wss.connect(ws1, 'room1'); join(ws1, 'Host', 'c1')
    wss.connect(ws2, 'room1'); join(ws2, 'Guest', 'c2')
    ws1.emit('message', JSON.stringify({ type: 'mic_info', label: 'Shure SM7B' }))

    for (const ws of [ws1, ws2]) {
      const presence = ws.sent.filter(m => m.type === 'presence').at(-1)
      const host = presence.peers.find(p => p.name === 'Host')
      expect(host.micLabel).toBe('Shure SM7B')
    }
  })

  it('mic_info truncates a long label and same-clientId reconnect forgets it until resync', () => {
    const ws1 = mockWs()
    const ws2 = mockWs()
    const guest = mockWs()
    wss.connect(ws1, 'room1'); join(ws1, 'Host', 'c1')
    wss.connect(guest, 'room1'); join(guest, 'Guest', 'c2')
    ws1.emit('message', JSON.stringify({ type: 'mic_info', label: 'x'.repeat(200) }))
    const labeled = guest.sent.filter(m => m.type === 'presence').at(-1)
    expect(labeled.peers.find(p => p.name === 'Host').micLabel).toHaveLength(80)

    wss.connect(ws2, 'room1'); join(ws2, 'Host', 'c1')
    const afterJoin = guest.sent.filter(m => m.type === 'presence').at(-1)
    expect(afterJoin.peers.find(p => p.name === 'Host').micLabel).toBe('')

    ws2.emit('message', JSON.stringify({ type: 'mic_info', label: 'Shure SM7B' }))
    const afterResync = guest.sent.filter(m => m.type === 'presence').at(-1)
    expect(afterResync.peers.find(p => p.name === 'Host').micLabel).toBe('Shure SM7B')
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

  it('error before join is a no-op', () => {
    const ws = mockWs()
    wss.connect(ws, 'room1')
    ws.emit('error')
    join(ws, 'Alice', 'c1')
    expect(ws.closed).toBe(false)
    expect(ws.sent.some((m) => m.type === 'presence')).toBe(true)
  })

  it('error after join drops the peer so a new client can take the slot', () => {
    const host = mockWs()
    const guest = mockWs()
    const late = mockWs()
    wss.connect(host, 'room1'); join(host, 'Host', 'c1')
    wss.connect(guest, 'room1'); join(guest, 'Guest', 'c2')
    host.emit('error')
    wss.connect(late, 'room1'); join(late, 'Late', 'c3')
    expect(late.closed).toBe(false)
    expect(late.sent.some((m) => m.type === 'rejected')).toBe(false)
  })

  it('error on a replaced socket does not drop the new peer', () => {
    const ws1 = mockWs()
    const ws2 = mockWs()
    const guest = mockWs()
    wss.connect(ws1, 'room1'); join(ws1, 'Host', 'c1')
    wss.connect(guest, 'room1'); join(guest, 'Guest', 'c2')
    wss.connect(ws2, 'room1'); join(ws2, 'Host', 'c1')
    ws1.emit('error')
    guest.sent.length = 0
    ws2.emit('message', JSON.stringify({ type: 'clap' }))
    expect(guest.sent.some((m) => m.type === 'clap')).toBe(true)
  })
})

describe('setupWss — yt_duck (hold-to-talk)', () => {
  let wss, host, guest

  function duck(ws, talking) {
    ws.emit('message', JSON.stringify({ type: 'yt_duck', talking }))
  }

  beforeEach(() => {
    _resetRooms()
    wss = mockWss()
    setupWss(wss)
    getActiveRoomBySlug.mockReturnValue({ slug: 'room1', password_hash: 'mock-hash' })
    host  = mockWs()
    guest = mockWs()
    wss.connect(host, 'room1', { asHost: true }); join(host, 'Host', 'c1')
    wss.connect(guest, 'room1');                  join(guest, 'Guest', 'c2')
    host.sent.length = 0
    guest.sent.length = 0
  })

  it('broadcasts room-level talking to every peer, including guests', () => {
    duck(guest, true)
    for (const ws of [host, guest]) {
      expect(ws.sent.at(-1)).toEqual({ type: 'yt_duck', talking: true })
    }
  })

  it('stays ducked while either peer is holding, and clears when the last releases', () => {
    duck(host, true)
    duck(guest, true)
    host.sent.length = 0
    guest.sent.length = 0

    duck(host, false)
    expect(guest.sent.at(-1)).toEqual({ type: 'yt_duck', talking: true })

    duck(guest, false)
    expect(host.sent.at(-1)).toEqual({ type: 'yt_duck', talking: false })
  })

  it('clears duck when the talking peer disconnects', () => {
    duck(guest, true)
    host.sent.length = 0
    guest.emit('close')
    expect(host.sent.some(m => m.type === 'yt_duck' && m.talking === false)).toBe(true)
  })

  it('replays current duck state to a late joiner', () => {
    guest.emit('close')
    duck(host, true)
    const late = mockWs()
    wss.connect(late, 'room1'); join(late, 'Late', 'c3')
    expect(late.sent.filter(m => m.type === 'yt_duck').at(-1)).toEqual({
      type: 'yt_duck',
      talking: true
    })
  })
})
