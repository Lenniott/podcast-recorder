import { describe, it, expect, beforeEach, vi } from 'vitest'

// ─── Mock db so ws-rooms doesn't need a real DB ─────────────────────────────
vi.mock('../../src/lib/server/db.js', () => ({
  roomExists: vi.fn(() => true),
  getRoomBySlug: vi.fn(() => ({
    slug: 'room1',
    password_hash: 'mock-hash'
  })),
  default: {}
}))

// ─── Mock auth so a known cookie value grants the host claim ────────────────
vi.mock('../../src/lib/server/auth.js', () => ({
  verifyHostClaimToken: vi.fn((token) => token === 'valid-host-token')
}))

import { roomExists } from '../../src/lib/server/db.js'
import { setupWss, _resetRooms } from '../../src/lib/server/ws-rooms.js'
import { MAX_TABS } from '../../src/lib/tab-sync.js'
import { mockWs, mockWss, join } from './ws-test-helpers.js'

function latest(ws, type) {
  return ws.sent.filter((m) => m.type === type).at(-1)
}

describe('setupWss — tabs (structure: create/switch/close)', () => {
  let wss, host, guest

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

  it('gives the room a single default tab on first join, active', () => {
    const state = latest(host, 'tabs_state')
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0].title).toBe('Tab 1')
    expect(state.activeTabId).toBe(state.tabs[0].id)
  })

  it('replays the default tab to a late joiner', () => {
    guest.emit('close') // free a slot — room is capped at MAX_PEERS
    const late = mockWs()
    wss.connect(late, 'room1'); join(late, 'Late', 'c3')
    const state = latest(late, 'tabs_state')
    expect(state.tabs).toHaveLength(1)
  })

  it('a guest can create a tab; it becomes active for everyone', () => {
    guest.emit('message', JSON.stringify({ type: 'tab_create', tabId: 't2', title: 'Notes' }))
    for (const ws of [host, guest]) {
      const state = latest(ws, 'tabs_state')
      expect(state.tabs.map((t) => t.title)).toEqual(['Tab 1', 'Notes'])
      expect(state.activeTabId).toBe('t2')
    }
  })

  it('defaults an untitled new tab to the next free "Tab N"', () => {
    host.emit('message', JSON.stringify({ type: 'tab_create', tabId: 't2' }))
    const state = latest(host, 'tabs_state')
    expect(state.tabs.map((t) => t.title)).toEqual(['Tab 1', 'Tab 2'])
  })

  it('rejects tab_create once the room is at MAX_TABS', () => {
    for (let i = 0; i < MAX_TABS - 1; i++) {
      host.emit('message', JSON.stringify({ type: 'tab_create', tabId: `extra-${i}` }))
    }
    expect(latest(host, 'tabs_state').tabs).toHaveLength(MAX_TABS)

    host.sent.length = 0
    host.emit('message', JSON.stringify({ type: 'tab_create', tabId: 'one-too-many' }))
    expect(host.sent.some((m) => m.type === 'error')).toBe(true)
    expect(host.sent.some((m) => m.type === 'tabs_state')).toBe(false)
  })

  it('tab_switch changes the active tab for everyone', () => {
    host.emit('message', JSON.stringify({ type: 'tab_create', tabId: 't2' }))
    guest.emit('message', JSON.stringify({ type: 'tab_switch', tabId: 't2' }))
    // switch back to the default tab and confirm broadcast reaches both peers
    const defaultTabId = latest(host, 'tabs_state').tabs[0].id
    guest.emit('message', JSON.stringify({ type: 'tab_switch', tabId: defaultTabId }))
    for (const ws of [host, guest]) {
      expect(latest(ws, 'tabs_state').activeTabId).toBe(defaultTabId)
    }
  })

  it('rejects tab_switch to an unknown tab id', () => {
    host.sent.length = 0
    host.emit('message', JSON.stringify({ type: 'tab_switch', tabId: 'nope' }))
    expect(host.sent.some((m) => m.type === 'error')).toBe(true)
    expect(host.sent.some((m) => m.type === 'tabs_state')).toBe(false)
  })

  it('tab_close removes a tab and reassigns the active tab if needed', () => {
    host.emit('message', JSON.stringify({ type: 'tab_create', tabId: 't2' })) // active = t2
    guest.emit('message', JSON.stringify({ type: 'tab_close', tabId: 't2' }))
    const state = latest(host, 'tabs_state')
    expect(state.tabs.map((t) => t.id)).not.toContain('t2')
    expect(state.activeTabId).not.toBe('t2')
  })

  it('rejects closing the last remaining tab', () => {
    const onlyTabId = latest(host, 'tabs_state').tabs[0].id
    host.sent.length = 0
    host.emit('message', JSON.stringify({ type: 'tab_close', tabId: onlyTabId }))
    expect(host.sent.some((m) => m.type === 'error')).toBe(true)
    expect(latest(host, 'tabs_state')).toBeUndefined()
  })

  it('rejects tab_close for an unknown tab id', () => {
    host.sent.length = 0
    host.emit('message', JSON.stringify({ type: 'tab_close', tabId: 'nope' }))
    expect(host.sent.some((m) => m.type === 'error')).toBe(true)
  })

  it('drops all tab state when the room empties, so the next joiner starts fresh', () => {
    host.emit('message', JSON.stringify({ type: 'tab_create', tabId: 't2' }))
    host.emit('close')
    guest.emit('close')

    const fresh = mockWs()
    wss.connect(fresh, 'room1'); join(fresh, 'Fresh', 'c9')
    expect(latest(fresh, 'tabs_state').tabs).toHaveLength(1)
  })
})

describe('setupWss — tab_video (per-tab shared video, symmetric control)', () => {
  let wss, host, guest, tabId

  function sendVideo(ws, payload) {
    ws.emit('message', JSON.stringify({ type: 'tab_video', tabId, ...payload }))
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
    tabId = latest(host, 'tabs_state').tabs[0].id
    host.sent.length = 0
    guest.sent.length = 0
  })

  it('lets a guest load a video into a tab — no host gate — stamped and broadcast to all', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(5000)
    sendVideo(guest, { action: 'load', videoId: 'dQw4w9WgXcQ', playing: true, positionSec: 42.5 })
    for (const ws of [host, guest]) {
      expect(latest(ws, 'tab_video')).toMatchObject({
        tabId,
        videoId: 'dQw4w9WgXcQ',
        playing: true,
        positionSec: 42.5,
        positionAtMs: 5250,
        triggerAtMs: 5250
      })
    }
    nowSpy.mockRestore()
  })

  it('lets the host control a video a guest loaded — fully symmetric', () => {
    sendVideo(guest, { action: 'load', videoId: 'dQw4w9WgXcQ', playing: false, positionSec: 0 })
    sendVideo(host, { action: 'control', videoId: 'dQw4w9WgXcQ', playing: true, positionSec: 12 })
    expect(latest(guest, 'tab_video')).toMatchObject({ videoId: 'dQw4w9WgXcQ', playing: true, positionSec: 12 })
  })

  it('rejects malformed video ids', () => {
    sendVideo(host, { action: 'load', videoId: 'javascript:alert(1)', playing: false, positionSec: 0 })
    expect(host.sent.some((m) => m.type === 'error')).toBe(true)
    expect(host.sent.some((m) => m.type === 'tab_video')).toBe(false)
  })

  it('rejects tab_video for an unknown tab id', () => {
    host.emit('message', JSON.stringify({ type: 'tab_video', tabId: 'nope', action: 'load', videoId: 'dQw4w9WgXcQ', playing: false, positionSec: 0 }))
    expect(host.sent.some((m) => m.type === 'error')).toBe(true)
  })

  it('ignores a "control" whose videoId does not match what is loaded in the tab', () => {
    sendVideo(host, { action: 'load', videoId: 'dQw4w9WgXcQ', playing: false, positionSec: 0 })
    host.sent.length = 0
    guest.sent.length = 0
    sendVideo(guest, { action: 'control', videoId: 'jNQXAC9IVRw', playing: true, positionSec: 5 })
    expect(host.sent.some((m) => m.type === 'tab_video')).toBe(false)
    expect(guest.sent.some((m) => m.type === 'tab_video')).toBe(false)
  })

  it('clearing a tab broadcasts an empty video state scoped to that tab', () => {
    sendVideo(host, { action: 'load', videoId: 'dQw4w9WgXcQ', playing: true, positionSec: 5 })
    sendVideo(guest, { action: 'clear', videoId: '', playing: false, positionSec: 0 })
    const clear = latest(host, 'tab_video')
    expect(clear).toMatchObject({ tabId, videoId: '' })
  })

  it('replays each tab\'s loaded video to a late joiner with a fresh triggerAtMs', () => {
    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValue(5000)
    sendVideo(host, { action: 'load', videoId: 'dQw4w9WgXcQ', playing: true, positionSec: 10 })
    guest.emit('close') // free a slot — room is capped at MAX_PEERS

    nowSpy.mockReturnValue(9000)
    const late = mockWs()
    wss.connect(late, 'room1'); join(late, 'Late', 'c3')

    const replay = latest(late, 'tab_video')
    expect(replay).toMatchObject({
      tabId,
      videoId: 'dQw4w9WgXcQ',
      positionSec: 10,
      positionAtMs: 5250,
      triggerAtMs: 9250
    })
    nowSpy.mockRestore()
  })
})

describe('setupWss — tab_text (shared textarea, symmetric)', () => {
  let wss, host, guest, tabId

  beforeEach(() => {
    _resetRooms()
    wss = mockWss()
    setupWss(wss)
    roomExists.mockReturnValue(true)
    host  = mockWs()
    guest = mockWs()
    wss.connect(host, 'room1', { asHost: true }); join(host, 'Host', 'c1')
    wss.connect(guest, 'room1');                  join(guest, 'Guest', 'c2')
    tabId = latest(host, 'tabs_state').tabs[0].id
    host.sent.length = 0
    guest.sent.length = 0
  })

  it('broadcasts an edit to every other peer but not back to the sender', () => {
    guest.emit('message', JSON.stringify({ type: 'tab_text', tabId, text: 'hello' }))
    expect(latest(host, 'tab_text')).toEqual({ type: 'tab_text', tabId, text: 'hello' })
    expect(guest.sent.some((m) => m.type === 'tab_text')).toBe(false)
  })

  it('truncates text to MAX_TAB_TEXT_LEN', async () => {
    const { MAX_TAB_TEXT_LEN } = await import('../../src/lib/tab-sync.js')
    const huge = 'x'.repeat(MAX_TAB_TEXT_LEN + 500)
    guest.emit('message', JSON.stringify({ type: 'tab_text', tabId, text: huge }))
    expect(latest(host, 'tab_text').text).toHaveLength(MAX_TAB_TEXT_LEN)
  })

  it('rejects tab_text for an unknown tab id', () => {
    guest.emit('message', JSON.stringify({ type: 'tab_text', tabId: 'nope', text: 'hi' }))
    expect(guest.sent.some((m) => m.type === 'error')).toBe(true)
  })

  it('replays non-empty tab text to a late joiner', () => {
    guest.emit('message', JSON.stringify({ type: 'tab_text', tabId, text: 'shared notes' }))
    guest.emit('close') // free a slot — room is capped at MAX_PEERS
    const late = mockWs()
    wss.connect(late, 'room1'); join(late, 'Late', 'c3')
    expect(latest(late, 'tab_text')).toEqual({ type: 'tab_text', tabId, text: 'shared notes' })
  })

  it('does not replay empty tab text to a late joiner', () => {
    guest.emit('close') // free a slot — room is capped at MAX_PEERS
    const late = mockWs()
    wss.connect(late, 'room1'); join(late, 'Late', 'c3')
    expect(latest(late, 'tabs_state')).toBeDefined() // sanity: late actually joined
    expect(late.sent.some((m) => m.type === 'tab_text')).toBe(false)
  })
})
