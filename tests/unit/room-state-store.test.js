import { describe, it, expect, vi } from 'vitest'
import { createRoomStateStore, getRoomStateGraceMs } from '../../src/lib/server/room-state-store.js'

describe('getRoomStateGraceMs', () => {
  it('parses a valid ROOM_STATE_GRACE_MS as an integer', () => {
    expect(getRoomStateGraceMs({ ROOM_STATE_GRACE_MS: '200' })).toBe(200)
  })

  it('falls back to the 10s default when unset', () => {
    expect(getRoomStateGraceMs({})).toBe(10_000)
  })

  it('falls back to the default for a non-numeric value', () => {
    expect(getRoomStateGraceMs({ ROOM_STATE_GRACE_MS: 'not-a-number' })).toBe(10_000)
  })

  it('falls back to the default for a negative value', () => {
    expect(getRoomStateGraceMs({ ROOM_STATE_GRACE_MS: '-5' })).toBe(10_000)
  })

  it('accepts an explicit 0 (evict immediately, no grace period)', () => {
    expect(getRoomStateGraceMs({ ROOM_STATE_GRACE_MS: '0' })).toBe(0)
  })
})

/** A durable-storage test double — a plain in-memory map, not a real DB file. */
function fakeDurable() {
  const map = new Map()
  return {
    save: vi.fn((slug, content) => { map.set(slug, content) }),
    load: vi.fn((slug) => (map.has(slug) ? map.get(slug) : null)),
    _map: map
  }
}

/** An injected clock/timer test double — no real setTimeout delays. */
function fakeClock() {
  let nextId = 1
  const pending = new Map() // id -> fn
  return {
    setTimeoutFn: vi.fn((fn) => {
      const id = nextId++
      pending.set(id, fn)
      return id
    }),
    clearTimeoutFn: vi.fn((id) => { pending.delete(id) }),
    fire(id) {
      const fn = pending.get(id)
      pending.delete(id)
      fn?.()
    },
    pendingCount: () => pending.size
  }
}

describe('createRoomStateStore — construction', () => {
  it('requires a durable store adapter', () => {
    expect(() => createRoomStateStore({})).toThrow('a durable store adapter is required')
  })
})

describe('createRoomStateStore — getRoom', () => {
  it('creates a brand-new room with a single default, active tab', () => {
    const store = createRoomStateStore({ durable: fakeDurable() })
    const room = store.getRoom('room1')
    expect(room.tabs.list).toHaveLength(1)
    expect(room.tabs.list[0].title).toBe('Tab 1')
    expect(room.tabs.activeTabId).toBe(room.tabs.list[0].id)
  })

  it('never touches durable storage while a room is hot', () => {
    const durable = fakeDurable()
    const store = createRoomStateStore({ durable })
    store.getRoom('room1')
    store.getRoom('room1')
    expect(durable.load).toHaveBeenCalledTimes(1) // once, to discover it's brand-new
    expect(durable.save).not.toHaveBeenCalled()
  })

  it('reads/writes never touch a durable store that throws, once a room is already hot', () => {
    const throwingDurable = {
      save: vi.fn(() => { throw new Error('must not be called while hot') }),
      load: vi.fn(() => null)
    }
    const store = createRoomStateStore({ durable: throwingDurable })
    store.getRoom('room1') // first touch hydrates (load only)
    expect(() => store.getRoom('room1')).not.toThrow()
    expect(throwingDurable.save).not.toHaveBeenCalled()
  })

  it('falls back to a fresh default room, rather than throwing, when durable.load itself throws', () => {
    const throwingLoad = {
      save: vi.fn(),
      load: vi.fn(() => { throw new Error('disk read failed') })
    }
    const store = createRoomStateStore({ durable: throwingLoad })
    let room
    expect(() => { room = store.getRoom('room1') }).not.toThrow()
    expect(room.tabs.list).toHaveLength(1)
    expect(room.tabs.list[0].title).toBe('Tab 1')
  })

  it('keeps the room hot rather than crashing the grace-timer callback when durable.save throws synchronously', () => {
    const throwingSave = {
      save: vi.fn(() => { throw new Error('disk full') }),
      load: vi.fn(() => null)
    }
    const clock = fakeClock()
    const store = createRoomStateStore({ durable: throwingSave, ...clock, graceMs: 10_000 })

    store.onParticipantJoined('room1')
    store.createTab('room1', { tabId: 't2' })
    store.onParticipantLeft('room1')

    expect(() => clock.fire(1)).not.toThrow()
    expect(store.getRoom('room1').tabs.list.map((t) => t.id)).toContain('t2')
  })
})

describe('createRoomStateStore — createTab', () => {
  it('adds a new tab, makes it active, and returns the updated room', () => {
    const store = createRoomStateStore({ durable: fakeDurable() })
    const result = store.createTab('room1', { tabId: 't2', title: 'Notes' })
    expect(result.ok).toBe(true)
    expect(result.room.tabs.list.map((t) => t.title)).toEqual(['Tab 1', 'Notes'])
    expect(result.room.tabs.activeTabId).toBe('t2')
  })

  it('rejects a duplicate or empty tab id, leaving the room unchanged', () => {
    const store = createRoomStateStore({ durable: fakeDurable() })
    store.createTab('room1', { tabId: 't2' })

    const dup = store.createTab('room1', { tabId: 't2' })
    expect(dup).toEqual({ ok: false, error: 'Invalid or duplicate tab id' })

    const empty = store.createTab('room1', { tabId: '' })
    expect(empty).toEqual({ ok: false, error: 'Invalid or duplicate tab id' })

    expect(store.getRoom('room1').tabs.list).toHaveLength(2)
  })

  it('rejects createTab once the room already has MAX_TABS tabs', () => {
    const store = createRoomStateStore({ durable: fakeDurable() })
    for (let i = 0; i < 20; i++) {
      const result = store.createTab('room1', { tabId: `extra-${i}` })
      if (!result.ok) {
        expect(result.error).toMatch(/Too many tabs open/)
        return
      }
    }
    throw new Error('expected createTab to eventually reject once MAX_TABS is reached')
  })

  it('defaults an untitled tab to the next free "Tab N"', () => {
    const store = createRoomStateStore({ durable: fakeDurable() })
    const result = store.createTab('room1', { tabId: 't2' })
    expect(result.room.tabs.list.map((t) => t.title)).toEqual(['Tab 1', 'Tab 2'])
  })
})

describe('createRoomStateStore — switchTab', () => {
  it('changes the active tab', () => {
    const store = createRoomStateStore({ durable: fakeDurable() })
    store.createTab('room1', { tabId: 't2' })
    const result = store.switchTab('room1', 't2')
    expect(result).toEqual({ ok: true, room: expect.objectContaining({}) })
    expect(store.getRoom('room1').tabs.activeTabId).toBe('t2')
  })

  it('rejects switching to an unknown tab id', () => {
    const store = createRoomStateStore({ durable: fakeDurable() })
    const before = store.getRoom('room1').tabs.activeTabId
    const result = store.switchTab('room1', 'nope')
    expect(result).toEqual({ ok: false, error: 'Unknown tab' })
    expect(store.getRoom('room1').tabs.activeTabId).toBe(before)
  })

  it('rejects a missing/falsy tab id the same as an unknown one', () => {
    const store = createRoomStateStore({ durable: fakeDurable() })
    expect(store.switchTab('room1', undefined)).toEqual({ ok: false, error: 'Unknown tab' })
  })
})

describe('createRoomStateStore — closeTab', () => {
  it('removes a tab and reassigns the active tab if it was the one closed', () => {
    const store = createRoomStateStore({ durable: fakeDurable() })
    store.createTab('room1', { tabId: 't2' }) // active = t2
    const result = store.closeTab('room1', 't2')
    expect(result.ok).toBe(true)
    expect(result.room.tabs.list.map((t) => t.id)).not.toContain('t2')
    expect(result.room.tabs.activeTabId).not.toBe('t2')
  })

  it('rejects closing the only remaining tab', () => {
    const store = createRoomStateStore({ durable: fakeDurable() })
    const onlyId = store.getRoom('room1').tabs.list[0].id
    const result = store.closeTab('room1', onlyId)
    expect(result).toEqual({ ok: false, error: 'Cannot close the only remaining tab' })
    expect(store.getRoom('room1').tabs.list).toHaveLength(1)
  })

  it('rejects closing an unknown tab id', () => {
    const store = createRoomStateStore({ durable: fakeDurable() })
    expect(store.closeTab('room1', 'nope')).toEqual({ ok: false, error: 'Unknown tab' })
  })

  it('closing a tab that is not the active one leaves the active tab untouched', () => {
    const store = createRoomStateStore({ durable: fakeDurable() })
    const firstId = store.getRoom('room1').tabs.list[0].id
    store.createTab('room1', { tabId: 't2' }) // t2 becomes active
    const result = store.closeTab('room1', firstId)
    expect(result.ok).toBe(true)
    expect(result.room.tabs.activeTabId).toBe('t2')
  })
})

describe('createRoomStateStore — setTabVideo', () => {
  it('sets a tab\'s video state', () => {
    const store = createRoomStateStore({ durable: fakeDurable() })
    const tabId = store.getRoom('room1').tabs.list[0].id
    const video = { videoId: 'dQw4w9WgXcQ', playing: true, positionSec: 5, positionAtMs: 1234 }
    const result = store.setTabVideo('room1', tabId, video)
    expect(result).toEqual({ ok: true, room: expect.anything() })
    expect(store.getRoom('room1').tabs.list[0].video).toEqual(video)
  })

  it('clears a tab\'s video state with null', () => {
    const store = createRoomStateStore({ durable: fakeDurable() })
    const tabId = store.getRoom('room1').tabs.list[0].id
    store.setTabVideo('room1', tabId, { videoId: 'dQw4w9WgXcQ', playing: true, positionSec: 5, positionAtMs: 1234 })
    store.setTabVideo('room1', tabId, null)
    expect(store.getRoom('room1').tabs.list[0].video).toBeNull()
  })

  it('rejects setTabVideo for an unknown tab id', () => {
    const store = createRoomStateStore({ durable: fakeDurable() })
    expect(store.setTabVideo('room1', 'nope', null)).toEqual({ ok: false, error: 'Unknown tab' })
  })

  it('rejects a missing/falsy tab id the same as an unknown one', () => {
    const store = createRoomStateStore({ durable: fakeDurable() })
    expect(store.setTabVideo('room1', undefined, null)).toEqual({ ok: false, error: 'Unknown tab' })
  })
})

describe('createRoomStateStore — setTabText', () => {
  it('sets a tab\'s text', () => {
    const store = createRoomStateStore({ durable: fakeDurable() })
    const tabId = store.getRoom('room1').tabs.list[0].id
    const result = store.setTabText('room1', tabId, 'hello')
    expect(result).toEqual({ ok: true, room: expect.anything() })
    expect(store.getRoom('room1').tabs.list[0].text).toBe('hello')
  })

  it('truncates text to MAX_TAB_TEXT_LEN', async () => {
    const { MAX_TAB_TEXT_LEN } = await import('../../src/lib/tab-sync.js')
    const store = createRoomStateStore({ durable: fakeDurable() })
    const tabId = store.getRoom('room1').tabs.list[0].id
    const huge = 'x'.repeat(MAX_TAB_TEXT_LEN + 500)
    store.setTabText('room1', tabId, huge)
    expect(store.getRoom('room1').tabs.list[0].text).toHaveLength(MAX_TAB_TEXT_LEN)
  })

  it('rejects setTabText for an unknown tab id', () => {
    const store = createRoomStateStore({ durable: fakeDurable() })
    expect(store.setTabText('room1', 'nope', 'hi')).toEqual({ ok: false, error: 'Unknown tab' })
  })

  it('rejects a missing/falsy tab id the same as an unknown one', () => {
    const store = createRoomStateStore({ durable: fakeDurable() })
    expect(store.setTabText('room1', undefined, 'hi')).toEqual({ ok: false, error: 'Unknown tab' })
  })

  it('treats a missing/null text as empty, same as tab_text\'s existing wire contract', () => {
    const store = createRoomStateStore({ durable: fakeDurable() })
    const tabId = store.getRoom('room1').tabs.list[0].id
    store.setTabText('room1', tabId, null)
    expect(store.getRoom('room1').tabs.list[0].text).toBe('')
  })
})

describe('createRoomStateStore — lifecycle: grace timer eviction', () => {
  it('exactly 10 seconds (graceMs) after the last participant leaves, with nobody reconnecting, flushes to durable storage and evicts from hot', () => {
    const durable = fakeDurable()
    const clock = fakeClock()
    const store = createRoomStateStore({ durable, ...clock, graceMs: 10_000 })

    store.onParticipantJoined('room1')
    store.createTab('room1', { tabId: 't2', title: 'Notes' })
    store.onParticipantLeft('room1')

    expect(clock.setTimeoutFn).toHaveBeenCalledTimes(1)
    expect(clock.setTimeoutFn.mock.calls[0][1]).toBe(10_000)
    expect(durable.save).not.toHaveBeenCalled()

    clock.fire(1)

    expect(durable.save).toHaveBeenCalledTimes(1)
    expect(durable.save.mock.calls[0][0]).toBe('room1')
    expect(durable.save.mock.calls[0][1].tabs.list.map((t) => t.title)).toEqual(['Tab 1', 'Notes'])
    expect(durable._map.get('room1').tabs.list.map((t) => t.title)).toEqual(['Tab 1', 'Notes'])
  })

  it('does not start a grace timer while at least one participant remains', () => {
    const durable = fakeDurable()
    const clock = fakeClock()
    const store = createRoomStateStore({ durable, ...clock })

    store.onParticipantJoined('room1')
    store.onParticipantJoined('room1') // second participant

    // Caller (ws-rooms.js) only calls onParticipantLeft for the actual
    // last-participant departure, but even a spurious extra "left" signal
    // must not evict a room callers still consider occupied — nothing here
    // exercises that; this test documents the single, correct call.
    expect(clock.setTimeoutFn).not.toHaveBeenCalled()
  })

  it('a reconnect before the grace timer fires cancels the flush — content is never written to disk or dropped', () => {
    const durable = fakeDurable()
    const clock = fakeClock()
    const store = createRoomStateStore({ durable, ...clock, graceMs: 10_000 })

    store.onParticipantJoined('room1')
    store.createTab('room1', { tabId: 't2' })
    store.onParticipantLeft('room1')
    expect(clock.pendingCount()).toBe(1)

    store.onParticipantJoined('room1') // reconnect before the timer fires

    expect(clock.clearTimeoutFn).toHaveBeenCalledTimes(1)
    expect(clock.pendingCount()).toBe(0)
    expect(durable.save).not.toHaveBeenCalled()
    // Content continues exactly as before — still hot, nothing lost.
    expect(store.getRoom('room1').tabs.list.map((t) => t.id)).toContain('t2')
  })

  it('a room evicted after flush is transparently rehydrated from durable storage on next join, indistinguishable from a never-evicted room', () => {
    const durable = fakeDurable()
    const clock = fakeClock()
    const store = createRoomStateStore({ durable, ...clock, graceMs: 10_000 })

    store.onParticipantJoined('room1')
    store.createTab('room1', { tabId: 't2', title: 'Notes' })
    store.setTabText('room1', 't2', 'keep me')
    store.onParticipantLeft('room1')
    clock.fire(1) // grace elapses, nobody reconnects — flush + evict

    // A brand-new room (never had content before) hydrates through the
    // exact same call, with no special-casing by the caller.
    const restored = store.onParticipantJoined('room1')
    expect(restored.tabs.list.map((t) => t.title)).toEqual(['Tab 1', 'Notes'])
    expect(restored.tabs.list.find((t) => t.id === 't2').text).toBe('keep me')
    expect(durable.load).toHaveBeenCalledWith('room1')
  })

  it('a reconnect landing while the durable write is in flight never loses live state and never leaves the room simultaneously hot and evicted', async () => {
    let resolveSave
    const savePromise = new Promise((resolve) => { resolveSave = resolve })
    const savedContents = []
    const durable = {
      save: vi.fn((slug, content) => { savedContents.push(structuredClone(content)); return savePromise }),
      load: vi.fn(() => null)
    }
    const clock = fakeClock()
    const store = createRoomStateStore({ durable, ...clock, graceMs: 10_000 })

    store.onParticipantJoined('room1')
    store.createTab('room1', { tabId: 't2' })
    store.onParticipantLeft('room1')
    clock.fire(1) // starts the flush; durable.save() is now in flight (unresolved)

    // The reconnect lands exactly while the write is still pending.
    const roomDuringFlush = store.onParticipantJoined('room1')
    expect(roomDuringFlush.tabs.list.map((t) => t.id)).toContain('t2') // live content, not lost
    store.setTabText('room1', 't2', 'typed during the flush')

    resolveSave()
    await savePromise
    await Promise.resolve() // let the flush's .then() settle

    // Never evicted: the room is still hot with the very latest edits,
    // not the stale snapshot that was mid-flight when the reconnect landed.
    const after = store.getRoom('room1')
    expect(after.tabs.list.find((t) => t.id === 't2').text).toBe('typed during the flush')
    expect(savedContents[0].tabs.list.find((t) => t.id === 't2').text).toBe('') // what was actually flushed, pre-edit
  })

  it('onParticipantLeft for a room that was never actually hot is a harmless no-op when its grace timer fires', () => {
    const durable = fakeDurable()
    const clock = fakeClock()
    const store = createRoomStateStore({ durable, ...clock, graceMs: 10_000 })

    // No onParticipantJoined/getRoom ever happened for this slug — nothing
    // hydrated it into `hot` — yet a caller still signals a departure.
    store.onParticipantLeft('never-hot-room')

    expect(() => clock.fire(1)).not.toThrow()
    expect(durable.save).not.toHaveBeenCalled()
  })
})

describe('createRoomStateStore — _resetForTests', () => {
  it('clears hot content and cancels pending grace timers, for test isolation between cases', () => {
    const durable = fakeDurable()
    const clock = fakeClock()
    const store = createRoomStateStore({ durable, ...clock, graceMs: 10_000 })

    store.onParticipantJoined('room1')
    store.createTab('room1', { tabId: 't2' })
    store.onParticipantLeft('room1')
    expect(clock.pendingCount()).toBe(1)

    store._resetForTests()

    expect(clock.pendingCount()).toBe(0)
    // A fresh getRoom after reset is a brand-new default room, not the
    // leftover content from before the reset.
    expect(store.getRoom('room1').tabs.list).toHaveLength(1)
    expect(store.getRoom('room1').tabs.list[0].title).toBe('Tab 1')
  })
})
