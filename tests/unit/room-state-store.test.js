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

  it('backfills an empty transcript for content hydrated from durable storage saved before the Transcript existed', () => {
    const legacyDurable = {
      save: vi.fn(),
      // A room saved by a pre-ticket-01 build — tabs/text/video only, no `transcript` key at all.
      load: vi.fn(() => ({ tabs: { list: [{ id: 't1', title: 'Tab 1', video: null, text: '' }], activeTabId: 't1' } }))
    }
    const store = createRoomStateStore({ durable: legacyDurable })
    const room = store.getRoom('room1')
    expect(room.transcript.lines).toEqual([])
    expect(() => store.appendTranscriptLine('room1', { speaker: 'Host', text: 'hi' })).not.toThrow()
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
    const { MAX_TAB_TEXT_LEN } = await import('../../src/lib/room/tab-sync.js')
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

describe('createRoomStateStore — transcript (append-only, ADR-0002)', () => {
  it('a brand-new room starts with an empty transcript', () => {
    const store = createRoomStateStore({ durable: fakeDurable() })
    const room = store.getRoom('room1')
    expect(room.transcript.lines).toEqual([])
  })

  it('appends a speaker-labeled line and returns it alongside the updated room', () => {
    const store = createRoomStateStore({ durable: fakeDurable() })
    const result = store.appendTranscriptLine('room1', { speaker: 'Host', text: 'Welcome to the show.' })
    expect(result.ok).toBe(true)
    expect(result.line).toMatchObject({ speaker: 'Host', text: 'Welcome to the show.' })
    expect(result.room.transcript.lines).toEqual([result.line])
    expect(store.getRoom('room1').transcript.lines).toEqual([result.line])
  })

  it('two near-simultaneous appends from different speakers both land, in a stable order, nothing dropped', () => {
    const store = createRoomStateStore({ durable: fakeDurable() })
    const first = store.appendTranscriptLine('room1', { speaker: 'Host', text: 'What do you think about that?' })
    const second = store.appendTranscriptLine('room1', { speaker: 'Guest', text: 'I think it is fascinating.' })
    const lines = store.getRoom('room1').transcript.lines
    expect(lines).toHaveLength(2)
    expect(lines[0]).toEqual(first.line)
    expect(lines[1]).toEqual(second.line)
  })

  it('rejects a line with no text, leaving the transcript unchanged', () => {
    const store = createRoomStateStore({ durable: fakeDurable() })
    const result = store.appendTranscriptLine('room1', { speaker: 'Host', text: '   ' })
    expect(result).toEqual({ ok: false, error: 'A transcript line needs both a speaker and text' })
    expect(store.getRoom('room1').transcript.lines).toEqual([])
  })

  it('rejects a line with no speaker, leaving the transcript unchanged', () => {
    const store = createRoomStateStore({ durable: fakeDurable() })
    const result = store.appendTranscriptLine('room1', { speaker: '', text: 'Hello' })
    expect(result).toEqual({ ok: false, error: 'A transcript line needs both a speaker and text' })
    expect(store.getRoom('room1').transcript.lines).toEqual([])
  })

  it('truncates an over-long speaker/text rather than rejecting it', async () => {
    const store = createRoomStateStore({ durable: fakeDurable() })
    const { MAX_TRANSCRIPT_LINE_LEN, MAX_TRANSCRIPT_SPEAKER_LEN } = await import('../../src/lib/room/transcript-sync.js')
    const result = store.appendTranscriptLine('room1', {
      speaker: 'x'.repeat(MAX_TRANSCRIPT_SPEAKER_LEN + 20),
      text: 'y'.repeat(MAX_TRANSCRIPT_LINE_LEN + 500)
    })
    expect(result.line.speaker).toHaveLength(MAX_TRANSCRIPT_SPEAKER_LEN)
    expect(result.line.text).toHaveLength(MAX_TRANSCRIPT_LINE_LEN)
  })

  it('refuses to close or hand-edit the reserved Transcript tab id — it is not a real tab to begin with', async () => {
    const { TRANSCRIPT_TAB_ID } = await import('../../src/lib/room/transcript-sync.js')
    const store = createRoomStateStore({ durable: fakeDurable() })
    store.getRoom('room1') // hydrate

    expect(store.closeTab('room1', TRANSCRIPT_TAB_ID)).toEqual({ ok: false, error: 'Unknown tab' })
    expect(store.setTabText('room1', TRANSCRIPT_TAB_ID, 'hand-typed')).toEqual({ ok: false, error: 'Unknown tab' })
    // No ordinary tab was affected by either attempt.
    expect(store.getRoom('room1').tabs.list).toHaveLength(1)
  })

  it('switchTab accepts the reserved Transcript id as a valid destination — "who the room is looking at" is genuinely shared', async () => {
    const { TRANSCRIPT_TAB_ID } = await import('../../src/lib/room/transcript-sync.js')
    const store = createRoomStateStore({ durable: fakeDurable() })
    const firstTabId = store.getRoom('room1').tabs.list[0].id

    const toTranscript = store.switchTab('room1', TRANSCRIPT_TAB_ID)
    expect(toTranscript).toEqual({ ok: true, room: expect.anything() })
    expect(store.getRoom('room1').tabs.activeTabId).toBe(TRANSCRIPT_TAB_ID)

    // And switching back to a real tab works exactly as before.
    const backToReal = store.switchTab('room1', firstTabId)
    expect(backToReal).toEqual({ ok: true, room: expect.anything() })
    expect(store.getRoom('room1').tabs.activeTabId).toBe(firstTabId)
  })

  it('survives a flush-and-evict/rehydrate cycle exactly like tabs/text/video already do', () => {
    const durable = fakeDurable()
    const clock = fakeClock()
    const store = createRoomStateStore({ durable, ...clock, graceMs: 10_000 })

    store.onParticipantJoined('room1')
    store.appendTranscriptLine('room1', { speaker: 'Host', text: 'First line.' })
    store.appendTranscriptLine('room1', { speaker: 'Guest', text: 'Second line.' })
    store.onParticipantLeft('room1')
    clock.fire(1) // grace elapses, nobody reconnects — flush + evict

    const restored = store.onParticipantJoined('room1')
    expect(restored.transcript.lines.map((l) => l.text)).toEqual(['First line.', 'Second line.'])
  })
})

describe('createRoomStateStore — research entries (per-tab, shared — see ADR-0002 and ticket 04)', () => {
  it('a brand-new room starts with no research entries for any tab', () => {
    const store = createRoomStateStore({ durable: fakeDurable() })
    const room = store.getRoom('room1')
    expect(room.research).toEqual({})
  })

  it('adds a pending entry under a specific tab id and returns it alongside the updated room', () => {
    const store = createRoomStateStore({ durable: fakeDurable() })
    const result = store.addResearchEntry('room1', 'tabA', { id: 'e1', question: 'Who invented the transistor?' })
    expect(result.ok).toBe(true)
    expect(result.entry).toMatchObject({
      id: 'e1',
      tabId: 'tabA',
      question: 'Who invented the transistor?',
      status: 'pending',
      answer: null,
      citations: [],
      error: null
    })
    expect(result.room.research.tabA).toEqual([result.entry])
    expect(store.getRoom('room1').research.tabA).toEqual([result.entry])
  })

  it('entries are strictly per-tab — adding under tab A never appears under tab B', () => {
    const store = createRoomStateStore({ durable: fakeDurable() })
    store.addResearchEntry('room1', 'tabA', { id: 'e1', question: 'Question for A' })
    store.addResearchEntry('room1', 'tabB', { id: 'e2', question: 'Question for B' })

    const room = store.getRoom('room1')
    expect(room.research.tabA.map((e) => e.id)).toEqual(['e1'])
    expect(room.research.tabB.map((e) => e.id)).toEqual(['e2'])
  })

  it('rejects an empty/blank question, leaving research state unchanged', () => {
    const store = createRoomStateStore({ durable: fakeDurable() })
    const result = store.addResearchEntry('room1', 'tabA', { id: 'e1', question: '   ' })
    expect(result).toEqual({ ok: false, error: 'A research question cannot be empty' })
    expect(store.getRoom('room1').research).toEqual({})
  })

  it('rejects a duplicate or missing entry id', () => {
    const store = createRoomStateStore({ durable: fakeDurable() })
    store.addResearchEntry('room1', 'tabA', { id: 'e1', question: 'first' })

    const dup = store.addResearchEntry('room1', 'tabA', { id: 'e1', question: 'second' })
    expect(dup).toEqual({ ok: false, error: 'Invalid or duplicate research entry id' })

    const missing = store.addResearchEntry('room1', 'tabA', { id: '', question: 'third' })
    expect(missing).toEqual({ ok: false, error: 'Invalid or duplicate research entry id' })

    expect(store.getRoom('room1').research.tabA).toHaveLength(1)
  })

  it('moves a pending entry to answered, storing the answer and citations', () => {
    const store = createRoomStateStore({ durable: fakeDurable() })
    store.addResearchEntry('room1', 'tabA', { id: 'e1', question: 'What is a haiku?' })

    const result = store.resolveResearchEntry('room1', 'e1', {
      answer: 'A haiku is a three-line Japanese poem.',
      citations: [{ url: 'https://example.com/haiku', title: 'Haiku basics' }]
    })

    expect(result.ok).toBe(true)
    expect(result.tabId).toBe('tabA')
    expect(result.entry).toMatchObject({
      id: 'e1',
      status: 'answered',
      answer: 'A haiku is a three-line Japanese poem.',
      citations: [{ url: 'https://example.com/haiku', title: 'Haiku basics' }],
      error: null
    })
    expect(store.getRoom('room1').research.tabA[0]).toEqual(result.entry)
  })

  it('moves a pending entry to errored, storing a visible error message', () => {
    const store = createRoomStateStore({ durable: fakeDurable() })
    store.addResearchEntry('room1', 'tabA', { id: 'e1', question: 'What is a haiku?' })

    const result = store.errorResearchEntry('room1', 'e1', { message: 'The Research Assistant could not be reached.' })

    expect(result.ok).toBe(true)
    expect(result.tabId).toBe('tabA')
    expect(result.entry).toMatchObject({
      id: 'e1',
      status: 'errored',
      answer: null,
      error: 'The Research Assistant could not be reached.'
    })
    expect(store.getRoom('room1').research.tabA[0]).toEqual(result.entry)
  })

  it('rejects resolving/erroring an unknown entry id', () => {
    const store = createRoomStateStore({ durable: fakeDurable() })
    expect(store.resolveResearchEntry('room1', 'nope', { answer: 'x' })).toEqual({ ok: false, error: 'Unknown research entry' })
    expect(store.errorResearchEntry('room1', 'nope', { message: 'x' })).toEqual({ ok: false, error: 'Unknown research entry' })
  })

  it('removes an entry outright, leaving the rest of that tab\'s history intact', () => {
    const store = createRoomStateStore({ durable: fakeDurable() })
    store.addResearchEntry('room1', 'tabA', { id: 'e1', question: 'first' })
    store.addResearchEntry('room1', 'tabA', { id: 'e2', question: 'second' })

    const result = store.removeResearchEntry('room1', 'e1')

    expect(result).toMatchObject({ ok: true, tabId: 'tabA', entryId: 'e1' })
    expect(store.getRoom('room1').research.tabA.map((e) => e.id)).toEqual(['e2'])
  })

  it('rejects removing an unknown entry id', () => {
    const store = createRoomStateStore({ durable: fakeDurable() })
    expect(store.removeResearchEntry('room1', 'nope')).toEqual({ ok: false, error: 'Unknown research entry' })
  })

  it('backfills an empty research map for content hydrated from durable storage saved before Research Assistant entries existed', () => {
    const legacyDurable = {
      save: vi.fn(),
      // A room saved by a pre-ticket-04 build — no `research` key at all.
      load: vi.fn(() => ({
        tabs: { list: [{ id: 't1', title: 'Tab 1', video: null, text: '' }], activeTabId: 't1' },
        transcript: { lines: [] }
      }))
    }
    const store = createRoomStateStore({ durable: legacyDurable })
    const room = store.getRoom('room1')
    expect(room.research).toEqual({})
    expect(() => store.addResearchEntry('room1', 't1', { id: 'e1', question: 'hi' })).not.toThrow()
  })

  it('survives a flush-and-evict/rehydrate cycle exactly like tabs/text/video/transcript already do', () => {
    const durable = fakeDurable()
    const clock = fakeClock()
    const store = createRoomStateStore({ durable, ...clock, graceMs: 10_000 })

    store.onParticipantJoined('room1')
    store.addResearchEntry('room1', 'tabA', { id: 'e1', question: 'Persisted question?' })
    store.resolveResearchEntry('room1', 'e1', { answer: 'Persisted answer.', citations: [] })
    store.onParticipantLeft('room1')
    clock.fire(1) // grace elapses, nobody reconnects — flush + evict

    const restored = store.onParticipantJoined('room1')
    expect(restored.research.tabA).toEqual([
      expect.objectContaining({ id: 'e1', status: 'answered', answer: 'Persisted answer.' })
    ])
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

describe('createRoomStateStore — Annotations (ADR-0008, ticket 03)', () => {
  function storeWithRoom() {
    const store = createRoomStateStore({ durable: fakeDurable(), ...fakeClock(), graceMs: 10_000 })
    const content = store.getRoom('room1')
    return { store, tabId: content.tabs.list[0].id }
  }

  const valid = { id: 'a1', kind: 'comment', quote: 'the moon landing', text: 'check the date', author: 'Host' }

  it('a brand-new room has an empty annotations map, keyed per tab only once used', () => {
    const { store, tabId } = storeWithRoom()
    expect(store.getRoom('room1').annotations).toEqual({})
    store.addAnnotation('room1', tabId, valid)
    expect(Object.keys(store.getRoom('room1').annotations)).toEqual([tabId])
  })

  it('stores the whole Annotation shape ticket 04 depends on', () => {
    const { store, tabId } = storeWithRoom()
    const { ok, entry } = store.addAnnotation('room1', tabId, valid)
    expect(ok).toBe(true)
    expect(Object.keys(entry).sort()).toEqual([
      'at', 'author', 'citations', 'customPromptId', 'error', 'id', 'kind', 'quote', 'status', 'tabId', 'text'
    ])
    expect(entry).toMatchObject({
      id: 'a1', tabId, kind: 'comment', quote: 'the moon landing', text: 'check the date', author: 'Host',
      // A Comment is complete the instant it is submitted — it is born
      // answered and nothing ever moves it (unlike a Card, below).
      status: 'answered', error: null, citations: [], customPromptId: null
    })
    expect(typeof entry.at).toBe('number')
  })

  it("freezes the quote: rewriting the tab's text afterwards never touches it", () => {
    const { store, tabId } = storeWithRoom()
    store.addAnnotation('room1', tabId, valid)
    store.setTabText('room1', tabId, 'the notes have been rewritten entirely')
    expect(store.getRoom('room1').annotations[tabId][0].quote).toBe('the moon landing')
  })

  it('is write-once: re-adding the same id returns the stored entry, marked duplicate', () => {
    const { store, tabId } = storeWithRoom()
    const first = store.addAnnotation('room1', tabId, valid)
    const again = store.addAnnotation('room1', tabId, { ...valid, quote: 'something else', text: 'rewritten' })
    expect(again.ok).toBe(true)
    expect(again.duplicate).toBe(true)
    expect(again.entry).toBe(first.entry)
    expect(store.getRoom('room1').annotations[tabId]).toHaveLength(1)
  })

  it('refuses an unknown tab, an unknown kind, an empty quote, an empty comment and a missing id', () => {
    const { store, tabId } = storeWithRoom()
    expect(store.addAnnotation('room1', 'tab-nope', valid).ok).toBe(false)
    expect(store.addAnnotation('room1', tabId, { ...valid, kind: 'nonsense' }).ok).toBe(false)
    expect(store.addAnnotation('room1', tabId, { ...valid, quote: '  ' }).ok).toBe(false)
    expect(store.addAnnotation('room1', tabId, { ...valid, text: '  ' }).ok).toBe(false)
    expect(store.addAnnotation('room1', tabId, { ...valid, id: '' }).ok).toBe(false)
    expect(store.getRoom('room1').annotations).toEqual({})
  })

  // ── Card Annotations (ADR-0008, ticket 05) ──────────────────────────────

  const card = { id: 'c1', kind: 'card', quote: 'the moon landing', author: 'Fact check', customPromptId: 'cp_1' }

  it('a Card is born pending with an empty body — its answer does not exist yet', () => {
    const { store, tabId } = storeWithRoom()
    const { ok, entry } = store.addAnnotation('room1', tabId, card)
    expect(ok).toBe(true)
    expect(entry).toMatchObject({
      id: 'c1', kind: 'card', status: 'pending', text: '', error: null, customPromptId: 'cp_1', author: 'Fact check'
    })
    // Real, stored state from the instant it is created, not a client-only
    // illusion — a rejoiner replaying this tab sees the pending Card.
    expect(store.getRoom('room1').annotations[tabId]).toHaveLength(1)
  })

  it('a Card still needs its quote — the excerpt is what the prompt runs on', () => {
    const { store, tabId } = storeWithRoom()
    expect(store.addAnnotation('room1', tabId, { ...card, quote: '   ' }).ok).toBe(false)
  })

  it('resolveAnnotation moves a pending Card to answered, leaving the frozen quote alone', () => {
    const { store, tabId } = storeWithRoom()
    const created = store.addAnnotation('room1', tabId, card)
    const resolved = store.resolveAnnotation('room1', 'c1', {
      text: 'Apollo 11 landed on 20 July 1969.',
      citations: [{ url: 'https://en.wikipedia.org/wiki/Apollo_11', title: 'Apollo 11' }]
    })
    expect(resolved.ok).toBe(true)
    expect(resolved.tabId).toBe(tabId)
    expect(resolved.entry).toMatchObject({
      status: 'answered',
      text: 'Apollo 11 landed on 20 July 1969.',
      error: null,
      quote: 'the moon landing',
      at: created.entry.at
    })
    expect(resolved.entry.citations).toEqual([
      { url: 'https://en.wikipedia.org/wiki/Apollo_11', title: 'Apollo 11' }
    ])
  })

  it('refuses to resolve a Card to an empty answer — a blank row explains nothing', () => {
    const { store, tabId } = storeWithRoom()
    store.addAnnotation('room1', tabId, card)
    expect(store.resolveAnnotation('room1', 'c1', { text: '   ' }).ok).toBe(false)
    expect(store.getRoom('room1').annotations[tabId][0].status).toBe('pending')
  })

  it('errorAnnotation moves a pending Card to a visible reason, never leaving it stuck', () => {
    const { store, tabId } = storeWithRoom()
    store.addAnnotation('room1', tabId, card)
    const errored = store.errorAnnotation('room1', 'c1', { message: 'The Research Assistant timed out.' })
    expect(errored.ok).toBe(true)
    expect(errored.entry).toMatchObject({
      status: 'errored', error: 'The Research Assistant timed out.', text: '', quote: 'the moon landing'
    })
  })

  it('resolve/error on an unknown annotation id is refused rather than silently creating one', () => {
    const { store } = storeWithRoom()
    expect(store.resolveAnnotation('room1', 'nope', { text: 'x' }).ok).toBe(false)
    expect(store.errorAnnotation('room1', 'nope', { message: 'x' }).ok).toBe(false)
  })

  it('finds a Card to resolve even after the room has switched to another tab', () => {
    const { store, tabId } = storeWithRoom()
    store.addAnnotation('room1', tabId, card)
    store.createTab('room1', { tabId: 'tab-second' })
    expect(store.getRoom('room1').tabs.activeTabId).toBe('tab-second')
    expect(store.resolveAnnotation('room1', 'c1', { text: 'an answer' }).tabId).toBe(tabId)
  })

  it('falls back to a display name rather than storing an empty author', () => {
    const { store, tabId } = storeWithRoom()
    expect(store.addAnnotation('room1', tabId, { ...valid, author: '   ' }).entry.author).toBe('Guest')
  })

  it('backfills the annotations map for room content saved before this content kind existed', () => {
    const durable = fakeDurable()
    durable._map.set('room1', {
      tabs: { list: [{ id: 't1', title: 'Tab 1', video: null, text: '' }], activeTabId: 't1' }
    })
    const store = createRoomStateStore({ durable, ...fakeClock(), graceMs: 10_000 })
    expect(store.getRoom('room1').annotations).toEqual({})
    expect(store.addAnnotation('room1', 't1', valid).ok).toBe(true)
  })

  it('survives a flush-and-evict/rehydrate cycle, quote intact', () => {
    const durable = fakeDurable()
    const clock = fakeClock()
    const store = createRoomStateStore({ durable, ...clock, graceMs: 10_000 })

    const tabId = store.onParticipantJoined('room1').tabs.list[0].id
    store.addAnnotation('room1', tabId, valid)
    store.onParticipantLeft('room1')
    clock.fire(1) // grace elapses, nobody reconnects — flush + evict

    const restored = store.onParticipantJoined('room1')
    expect(restored.annotations[tabId]).toEqual([
      expect.objectContaining({ quote: 'the moon landing', text: 'check the date', kind: 'comment' })
    ])
  })
})
