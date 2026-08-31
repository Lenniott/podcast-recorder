import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import db, {
  cleanupExpiredRooms,
  createRoom,
  deleteRoom,
  deleteRoomContent,
  getActiveRoomBySlug,
  getRoomBySlug,
  loadRoomContent,
  roomExists,
  saveRoomContent,
  _resetDb
} from '../../src/lib/server/db.js'
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

  it('returns false for an expired room and removes its metadata and server copies', () => {
    createRoom(ROOM)
    db.getDb().prepare('UPDATE rooms SET created_at = ? WHERE slug = ?').run(1000, ROOM.slug)
    const copyDir = getServerCopyRoomDir(ROOM.slug)
    mkdirSync(copyDir, { recursive: true })
    writeFileSync(join(copyDir, 'dummy.partial'), 'not audio')

    expect(roomExists(ROOM.slug)).toBe(false)
    expect(getRoomBySlug(ROOM.slug)).toBeNull()
    expect(existsSync(copyDir)).toBe(false)
  })
})

describe('active room cleanup', () => {
  it('returns active rooms without deleting them', () => {
    createRoom(ROOM)
    expect(getActiveRoomBySlug(ROOM.slug)).toMatchObject({ slug: ROOM.slug })
    expect(getRoomBySlug(ROOM.slug)).toMatchObject({ slug: ROOM.slug })
  })

  it('cleanupExpiredRooms deletes only expired rooms and their server copies', () => {
    createRoom(ROOM)
    createRoom({ ...ROOM, slug: 'freshroom2' })
    db.getDb().prepare('UPDATE rooms SET created_at = ? WHERE slug = ?').run(1000, ROOM.slug)

    const expiredDir = getServerCopyRoomDir(ROOM.slug)
    const freshDir = getServerCopyRoomDir('freshroom2')
    mkdirSync(expiredDir, { recursive: true })
    mkdirSync(freshDir, { recursive: true })
    writeFileSync(join(expiredDir, 'dummy.partial'), 'not audio')
    writeFileSync(join(freshDir, 'dummy.partial'), 'not audio')

    expect(cleanupExpiredRooms({ now: 13 * 60 * 60 * 1000 })).toBe(1)
    expect(getRoomBySlug(ROOM.slug)).toBeNull()
    expect(getRoomBySlug('freshroom2')).toMatchObject({ slug: 'freshroom2' })
    expect(existsSync(expiredDir)).toBe(false)
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

  it('cleanupExpiredRooms removes an incomplete server copy for an expired room the same as a complete one', () => {
    createRoom(ROOM)
    db.getDb().prepare('UPDATE rooms SET created_at = ? WHERE slug = ?').run(1000, ROOM.slug)
    appendServerCopyChunk(ROOM.slug, 'guest1', Buffer.from([9, 9]), 0) // upload started, never finalized

    expect(cleanupExpiredRooms({ now: 13 * 60 * 60 * 1000 })).toBe(1)

    expect(existsSync(getServerCopyFilePath(ROOM.slug, 'guest1'))).toBe(false)
    expect(existsSync(getServerCopyRoomDir(ROOM.slug))).toBe(false)
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

  it('cleanupExpiredRooms removes durable room content for an expired room the same as its metadata', () => {
    createRoom(ROOM)
    db.getDb().prepare('UPDATE rooms SET created_at = ? WHERE slug = ?').run(1000, ROOM.slug)
    saveRoomContent(ROOM.slug, { tabs: { list: [], activeTabId: null } })

    expect(cleanupExpiredRooms({ now: 13 * 60 * 60 * 1000 })).toBe(1)

    expect(loadRoomContent(ROOM.slug)).toBeNull()
  })
})
