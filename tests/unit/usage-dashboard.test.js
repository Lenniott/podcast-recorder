import { closeSync, ftruncateSync, mkdirSync, openSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, it, expect, beforeEach } from 'vitest'
import { createRoom, getGuestLastAccess, getRoomBySlug, recordResearchUsage, saveRoomContent, setGuestLockAt, _resetDb } from '../../src/lib/server/db.js'
import { appendServerCopyChunk, getServerCopyRoomDir, writeServerCopyMetadata } from '../../src/lib/server/server-copy-storage.js'
import { getUsageDashboard, hideTestRoomsInDashboard } from '../../src/lib/server/usage-dashboard.js'

const SLUG_REAL = 'realroom01'
const SLUG_E2E = 'e2eroom01'

beforeEach(() => {
  process.env.DB_PATH = ':memory:'
  process.env.SERVER_COPY_DIR = ':memory:not-a-real-dir' // no files on disk — recordingSeconds stays 0
  _resetDb()
})

describe('hideTestRoomsInDashboard', () => {
  it('is off by default and for any unrecognized value', () => {
    expect(hideTestRoomsInDashboard({})).toBe(false)
    expect(hideTestRoomsInDashboard({ HIDE_TEST_ROOMS_IN_DASHBOARD: 'nope' })).toBe(false)
  })

  it('is on for 1/true/yes, case-insensitively', () => {
    expect(hideTestRoomsInDashboard({ HIDE_TEST_ROOMS_IN_DASHBOARD: '1' })).toBe(true)
    expect(hideTestRoomsInDashboard({ HIDE_TEST_ROOMS_IN_DASHBOARD: 'TRUE' })).toBe(true)
  })
})

describe('getUsageDashboard', () => {
  beforeEach(() => {
    createRoom({ slug: SLUG_REAL, name: 'A real episode', passwordHash: 'x' })
    createRoom({ slug: SLUG_E2E, name: 'E2E SomeSpec 12345', passwordHash: 'x' })
  })

  it('includes the join code, with null for a legacy room whose code was not stored', () => {
    createRoom({ slug: 'codedroom1', name: 'Coded episode', passwordHash: 'hash', passwordPlain: 'episode-42' })
    const { rooms } = getUsageDashboard({})
    expect(rooms.find(room => room.slug === 'codedroom1').roomCode).toBe('episode-42')
    expect(rooms.find(room => room.slug === SLUG_REAL).roomCode).toBeNull()
  })

  it('reports nonzero usage, content counts, and the sum of copies at their own sample rates', () => {
    const slug = 'statsroom1'
    const copyRoot = join(tmpdir(), `usage-stats-${process.pid}-${Date.now()}`)
    process.env.SERVER_COPY_DIR = copyRoot
    createRoom({ slug, name: 'Stats', passwordHash: 'hash' })
    saveRoomContent(slug, {
      tabs: { list: [{ id: 't1' }, { id: 't2' }], activeTabId: 't1' },
      research: { t1: [{ id: 'one' }, { id: 'two' }], t2: [{ id: 'three' }] },
      transcript: { lines: [{ text: '  three   spoken words  ' }, { text: 'and two' }, { text: '' }] }
    })
    recordResearchUsage({ roomSlug: slug, mode: 'test', tokens: 100, cost: 0.25 })
    recordResearchUsage({ roomSlug: slug, mode: 'test', tokens: 50, cost: 0.5 })
    appendServerCopyChunk(slug, 'guest-a', Buffer.alloc(192000), 0)
    writeServerCopyMetadata(slug, 'guest-a', { sampleRate: 48000 })
    appendServerCopyChunk(slug, 'guest-b', Buffer.alloc(96000), 0)
    writeServerCopyMetadata(slug, 'guest-b', { sampleRate: 16000 })
    try {
      const dashboard = getUsageDashboard({})
      expect(dashboard.totals).toEqual({ calls: 2, tokens: 150, cost: 0.75 })
      expect(dashboard.rooms.find(room => room.slug === slug)).toMatchObject({
        calls: 2, tokens: 150, cost: 0.75, recordingSeconds: 5,
        transcriptWords: 5, tabCount: 2, researchCardCount: 3
      })
    } finally {
      rmSync(copyRoot, { recursive: true, force: true })
    }
  })

  it('lists every room, e2e included, when the flag is off', () => {
    const { rooms } = getUsageDashboard({})
    expect(rooms.map((r) => r.slug).sort()).toEqual([SLUG_E2E, SLUG_REAL].sort())
  })

  it('excludes rooms named "E2E ..." from the per-room table when the flag is on', () => {
    const { rooms } = getUsageDashboard({ HIDE_TEST_ROOMS_IN_DASHBOARD: 'true' })
    expect(rooms.map((r) => r.slug)).toEqual([SLUG_REAL])
  })

  it("a room row's createdAt equals the room's insert time", () => {
    const before = Date.now()
    createRoom({ slug: 'timedroom1', name: 'Timed episode', passwordHash: 'x' })
    const after = Date.now()
    const room = getRoomBySlug('timedroom1')
    const { rooms } = getUsageDashboard({})
    const row = rooms.find((r) => r.slug === room.slug)
    expect(row.createdAt).toBe(room.created_at)
    expect(row.createdAt).toBeGreaterThanOrEqual(before)
    expect(row.createdAt).toBeLessThanOrEqual(after)
  })

  it('marks guestLocked from server audio plus an old guest-lock clock, and keeps createdAt as the insert time', () => {
    process.env.GUEST_LOCK_HOURS = '12'
    const copyRoot = join(tmpdir(), `usage-guest-lock-${process.pid}-${Date.now()}`)
    process.env.SERVER_COPY_DIR = copyRoot
    const old = Date.now() - 13 * 60 * 60 * 1000
    setGuestLockAt(SLUG_REAL, old)
    setGuestLockAt(SLUG_E2E, old)
    const dir = getServerCopyRoomDir(SLUG_REAL)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'mic.wav'), Buffer.from([1, 2, 3, 4]))

    try {
      const inserted = getRoomBySlug(SLUG_REAL)
      const quiet = getRoomBySlug(SLUG_E2E)
      const { rooms } = getUsageDashboard({})
      const withAudio = rooms.find((room) => room.slug === SLUG_REAL)
      const withoutAudio = rooms.find((room) => room.slug === SLUG_E2E)
      expect(withAudio.guestLocked).toBe(true)
      expect(withAudio.createdAt).toBe(inserted.created_at)
      expect(inserted.guest_lock_at).toBe(old)
      expect(withoutAudio.guestLocked).toBe(false)
      expect(withoutAudio.createdAt).toBe(quiet.created_at)
    } finally {
      rmSync(copyRoot, { recursive: true, force: true })
    }
  })

  it('marks guestLocked when one guest is inactivity-locked even if the time-lock clock is fresh', () => {
    const copyRoot = join(tmpdir(), `usage-guest-idle-${process.pid}-${Date.now()}`)
    process.env.SERVER_COPY_DIR = copyRoot
    const now = Date.now()
    setGuestLockAt(SLUG_REAL, now)
    const dir = getServerCopyRoomDir(SLUG_REAL)
    mkdirSync(dir, { recursive: true })
    const fd = openSync(join(dir, 'idleguest01.wav'), 'w')
    try {
      writeFileSync(fd, Buffer.alloc(44))
      ftruncateSync(fd, 44 + 48000 * 2 * 601)
    } finally {
      closeSync(fd)
    }

    try {
      expect(getGuestLastAccess(SLUG_REAL, 'idleguest01')).toBeNull()
      const { rooms } = getUsageDashboard({
        GUEST_LOCK_HOURS: '12',
        GUEST_LOCK_RECORDING_MINUTES: '10',
        GUEST_LOCK_INACTIVITY_HOURS: '2'
      })
      const row = rooms.find((room) => room.slug === SLUG_REAL)
      const quiet = rooms.find((room) => room.slug === SLUG_E2E)
      expect(row.guestLocked).toBe(true)
      expect(getRoomBySlug(SLUG_REAL).guest_lock_at).toBe(now)
      expect(quiet.guestLocked).toBe(false)
    } finally {
      rmSync(copyRoot, { recursive: true, force: true })
    }
  })

  it('every room row carries the shape the dashboard renders, defaulting to zero with no usage yet', () => {
    const { rooms } = getUsageDashboard({})
    const real = rooms.find((r) => r.slug === SLUG_REAL)
    expect(real).toMatchObject({
      name: 'A real episode',
      calls: 0,
      tokens: 0,
      cost: 0,
      recordingSeconds: 0,
      transcriptWords: 0,
      tabCount: 1, // a fresh room always starts with one tab — see room-state-store.js
      researchCardCount: 0
    })
  })
})
