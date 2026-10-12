import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import db, {
  cleanupExpiredRooms,
  createRoom,
  deleteRoom,
  deleteRoomContent,
  createCustomPrompt,
  getActiveRoomBySlug,
  getRoomBySlug,
  listCustomPrompts,
  listRooms,
  loadRoomContent,
  roomExists,
  saveRoomContent,
  setGuestLockAt,
  updateCustomPrompt,
  _resetDb
} from '../../src/lib/server/db.js'
import { guestLockAt } from '../../src/lib/server/room-lifetime.js'
import { getUsageDashboard } from '../../src/lib/server/usage-dashboard.js'
import {
  getServerCopyRoomDir,
  appendServerCopyChunk,
  getServerCopyFilePath,
  isServerCopyFinalized
} from '../../src/lib/server/server-copy-storage.js'

// Fresh in-memory DB before each test (DB_PATH=':memory:' set in setup.js)
let serverCopyDir

beforeEach(() => {
  if (serverCopyDir) rmSync(serverCopyDir, { recursive: true, force: true })
  serverCopyDir = join(tmpdir(), `podcast-recorder-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  process.env.SERVER_COPY_DIR = serverCopyDir
  process.env.ROOM_MAX_AGE_HOURS = '12'
  _resetDb()
})

const ROOM = {
  slug:         'testslug01',
  name:         'Test Episode',
  passwordHash: '$2a$10$fakehash'
}

describe('createRoom / getRoomBySlug', () => {
  it('stores a room and retrieves it by slug', () => {
    createRoom(ROOM)
    const found = getRoomBySlug(ROOM.slug)
    expect(found.slug).toBe(ROOM.slug)
    expect(found.name).toBe(ROOM.name)
    expect(found.password_hash).toBe(ROOM.passwordHash)
    expect(found.created_at).toBeGreaterThan(0)
  })

  it('returns null for an unknown slug', () => {
    expect(getRoomBySlug('doesnotexist')).toBeNull()
  })

  it('throws on duplicate slug', () => {
    createRoom(ROOM)
    expect(() => createRoom(ROOM)).toThrow()
  })
})

describe('roomExists', () => {
  it('returns true for an existing room', () => {
    createRoom(ROOM)
    expect(roomExists(ROOM.slug)).toBe(true)
  })

  it('returns false for a missing room', () => {
    expect(roomExists('nope')).toBe(false)
  })

  it('returns true for an old room and leaves its metadata and server copies in place', () => {
    createRoom(ROOM)
    db.getDb().prepare('UPDATE rooms SET created_at = ?, guest_lock_at = ? WHERE slug = ?').run(1000, 1000, ROOM.slug)
    const copyDir = getServerCopyRoomDir(ROOM.slug)
    mkdirSync(copyDir, { recursive: true })
    writeFileSync(join(copyDir, 'dummy.partial'), 'not audio')

    expect(roomExists(ROOM.slug)).toBe(true)
    expect(getRoomBySlug(ROOM.slug)).toMatchObject({ slug: ROOM.slug, created_at: 1000 })
    expect(existsSync(copyDir)).toBe(true)
  })
})

describe('active room cleanup', () => {
  it('returns active rooms without deleting them', () => {
    createRoom(ROOM)
    expect(getActiveRoomBySlug(ROOM.slug)).toMatchObject({ slug: ROOM.slug })
    expect(getRoomBySlug(ROOM.slug)).toMatchObject({ slug: ROOM.slug })
  })

  it('cleanupExpiredRooms deletes nothing, including an old room and its server copies', () => {
    createRoom(ROOM)
    createRoom({ ...ROOM, slug: 'freshroom2' })
    db.getDb().prepare('UPDATE rooms SET created_at = ?, guest_lock_at = ? WHERE slug = ?').run(1000, 1000, ROOM.slug)

    const oldDir = getServerCopyRoomDir(ROOM.slug)
    const freshDir = getServerCopyRoomDir('freshroom2')
    mkdirSync(oldDir, { recursive: true })
    mkdirSync(freshDir, { recursive: true })
    writeFileSync(join(oldDir, 'dummy.partial'), 'not audio')
    writeFileSync(join(freshDir, 'dummy.partial'), 'not audio')

    expect(cleanupExpiredRooms({ now: 13 * 60 * 60 * 1000 })).toBe(0)
    expect(getRoomBySlug(ROOM.slug)).toMatchObject({ slug: ROOM.slug, created_at: 1000 })
    expect(getRoomBySlug('freshroom2')).toMatchObject({ slug: 'freshroom2' })
    expect(existsSync(oldDir)).toBe(true)
    expect(existsSync(freshDir)).toBe(true)
  })

  it('deleteRoom removes room metadata and server copies', () => {
    createRoom(ROOM)
    const copyDir = getServerCopyRoomDir(ROOM.slug)
    mkdirSync(copyDir, { recursive: true })
    writeFileSync(join(copyDir, 'dummy.complete'), 'not audio')

    expect(deleteRoom(ROOM.slug)).toBe(1)
    expect(getRoomBySlug(ROOM.slug)).toBeNull()
    expect(existsSync(copyDir)).toBe(false)
  })

  it('rejects path traversal slugs for server-copy storage', () => {
    expect(() => getServerCopyRoomDir('../bad')).toThrow('Invalid room slug')
  })

  // Ticket 08: a participant who left/disconnected mid-upload never
  // finalizes — the server copy is raw .pcm chunks with no .wav (see
  // server-copy-storage.js's isServerCopyFinalized). Cleanup must not treat
  // that any differently from a complete copy: removeServerCopiesForRoom
  // removes the whole room directory regardless of what's in it, so an
  // interrupted/never-finalized upload must be swept up right along with
  // finished ones, not left behind as an orphan on disk.
  it('deleteRoom removes an incomplete (never-finalized) server copy left behind by an interrupted upload', () => {
    createRoom(ROOM)
    appendServerCopyChunk(ROOM.slug, 'guest1', Buffer.from([1, 2, 3]), 0)
    expect(isServerCopyFinalized(ROOM.slug, 'guest1')).toBe(false) // genuinely incomplete, not just empty

    expect(deleteRoom(ROOM.slug)).toBe(1)

    expect(existsSync(getServerCopyFilePath(ROOM.slug, 'guest1'))).toBe(false)
    expect(existsSync(getServerCopyRoomDir(ROOM.slug))).toBe(false)
  })

  it('cleanupExpiredRooms leaves an incomplete server copy in place for an old room', () => {
    createRoom(ROOM)
    db.getDb().prepare('UPDATE rooms SET created_at = ?, guest_lock_at = ? WHERE slug = ?').run(1000, 1000, ROOM.slug)
    appendServerCopyChunk(ROOM.slug, 'guest1', Buffer.from([9, 9]), 0) // upload started, never finalized

    expect(cleanupExpiredRooms({ now: 13 * 60 * 60 * 1000 })).toBe(0)

    expect(existsSync(getServerCopyFilePath(ROOM.slug, 'guest1'))).toBe(true)
    expect(existsSync(getServerCopyRoomDir(ROOM.slug))).toBe(true)
    expect(getRoomBySlug(ROOM.slug)).toMatchObject({ slug: ROOM.slug, created_at: 1000 })
  })

  it('returns an old room without deleting it, even when cleanupExpired is true', () => {
    createRoom(ROOM)
    const createdAt = 1000
    db.getDb().prepare('UPDATE rooms SET created_at = ?, guest_lock_at = ? WHERE slug = ?').run(createdAt, createdAt, ROOM.slug)
    const copyDir = getServerCopyRoomDir(ROOM.slug)
    mkdirSync(copyDir, { recursive: true })
    writeFileSync(join(copyDir, 'dummy.partial'), 'not audio')

    const found = getActiveRoomBySlug(ROOM.slug, { now: Date.now(), cleanupExpired: true })

    expect(found).toMatchObject({ slug: ROOM.slug, created_at: createdAt })
    expect(getRoomBySlug(ROOM.slug)).toMatchObject({ slug: ROOM.slug, created_at: createdAt })
    expect(listRooms().some((room) => room.slug === ROOM.slug && room.created_at === createdAt)).toBe(true)
    expect(existsSync(copyDir)).toBe(true)

    const listed = getUsageDashboard({}).rooms.find((room) => room.slug === ROOM.slug)
    expect(listed).toMatchObject({ name: ROOM.name, createdAt })
  })

  it('reads a missing guest-lock clock as created_at, and setGuestLockAt moves only that clock', () => {
    createRoom(ROOM)
    const inserted = getRoomBySlug(ROOM.slug)
    expect(guestLockAt(inserted)).toBe(inserted.created_at)
    expect(guestLockAt({ created_at: 42 })).toBe(42)
    expect(guestLockAt({ created_at: 42, guest_lock_at: null })).toBe(42)
    expect(guestLockAt({ created_at: 42, guest_lock_at: Number.NaN })).toBe(42)
    expect(guestLockAt({ created_at: 42, guest_lock_at: 99 })).toBe(99)

    db.getDb().prepare('UPDATE rooms SET guest_lock_at = NULL WHERE slug = ?').run(ROOM.slug)
    const legacy = getRoomBySlug(ROOM.slug)
    expect(guestLockAt(legacy)).toBe(legacy.created_at)
    expect(legacy.created_at).toBe(inserted.created_at)

    const next = inserted.created_at + 60_000
    expect(setGuestLockAt(ROOM.slug, next)).toBe(1)
    const updated = getRoomBySlug(ROOM.slug)
    expect(guestLockAt(updated)).toBe(next)
    expect(updated.created_at).toBe(inserted.created_at)
    expect(updated.name).toBe(inserted.name)
    expect(updated.password_hash).toBe(inserted.password_hash)
    expect(updated.password_plain).toBe(inserted.password_plain)
    expect(updated.slug).toBe(inserted.slug)

    expect(setGuestLockAt('missing-slug', next)).toBe(0)
    expect(getRoomBySlug('missing-slug')).toBeNull()
    expect(getRoomBySlug(ROOM.slug).created_at).toBe(inserted.created_at)
  })
})

describe('room content durable store (Room State Store\'s durable adapter)', () => {
  it('returns null for a room with no saved content', () => {
    expect(loadRoomContent('nosuchroom')).toBeNull()
  })

  it('saves and loads a room\'s content back exactly', () => {
    const content = { tabs: { list: [{ id: 't1', title: 'Tab 1', video: null, text: 'hello' }], activeTabId: 't1' } }
    saveRoomContent(ROOM.slug, content)
    expect(loadRoomContent(ROOM.slug)).toEqual(content)
  })

  it('a second save for the same slug overwrites rather than duplicating', () => {
    saveRoomContent(ROOM.slug, { tabs: { list: [], activeTabId: null } })
    const updated = { tabs: { list: [{ id: 't2', title: 'Tab 2', video: null, text: '' }], activeTabId: 't2' } }
    saveRoomContent(ROOM.slug, updated)

    expect(loadRoomContent(ROOM.slug)).toEqual(updated)
    expect(db.getDb().prepare('SELECT COUNT(*) AS n FROM room_content WHERE slug = ?').get(ROOM.slug).n).toBe(1)
  })

  it('deleteRoomContent removes a room\'s saved content', () => {
    saveRoomContent(ROOM.slug, { tabs: { list: [], activeTabId: null } })
    expect(deleteRoomContent(ROOM.slug)).toBe(1)
    expect(loadRoomContent(ROOM.slug)).toBeNull()
  })

  it('deleteRoomContent is a no-op for a slug with no saved content', () => {
    expect(deleteRoomContent('nosuchroom')).toBe(0)
  })

  it('deleteRoom also removes any durable room content for that slug — closing the gap where tab state was never pruned on room expiry', () => {
    createRoom(ROOM)
    saveRoomContent(ROOM.slug, { tabs: { list: [{ id: 't1', title: 'Tab 1', video: null, text: 'notes' }], activeTabId: 't1' } })

    expect(deleteRoom(ROOM.slug)).toBe(1)

    expect(loadRoomContent(ROOM.slug)).toBeNull()
  })

  it('cleanupExpiredRooms leaves durable room content in place for an old room', () => {
    createRoom(ROOM)
    db.getDb().prepare('UPDATE rooms SET created_at = ?, guest_lock_at = ? WHERE slug = ?').run(1000, 1000, ROOM.slug)
    const content = { tabs: { list: [], activeTabId: null } }
    saveRoomContent(ROOM.slug, content)

    expect(cleanupExpiredRooms({ now: 13 * 60 * 60 * 1000 })).toBe(0)

    expect(loadRoomContent(ROOM.slug)).toEqual(content)
    expect(getRoomBySlug(ROOM.slug)).toMatchObject({ slug: ROOM.slug, created_at: 1000 })
  })
})

// Full Custom Prompt CRUD lives in custom-prompts.test.js — this is only the
// storage-shape check that used to cover the two retired settings rows.
describe('Custom Prompt storage', () => {
  it('starts empty', () => {
    expect(listCustomPrompts()).toEqual([])
  })

  it('stores and reads a Custom Prompt back by its own id', () => {
    const created = createCustomPrompt({ title: '  Interpret  ', prompt: 'Read {current_tab}.' })
    expect(listCustomPrompts()).toEqual([
      { id: created.id, title: 'Interpret', prompt: 'Read {current_tab}.', outputFormat: 'text' }
    ])
  })

  it('edits in place rather than duplicating', () => {
    const created = createCustomPrompt({ title: 'Interpret', prompt: 'a' })
    updateCustomPrompt(created.id, { title: 'TSIA', prompt: 'b' })
    expect(listCustomPrompts()).toEqual([{ id: created.id, title: 'TSIA', prompt: 'b', outputFormat: 'text' }])
  })
})
