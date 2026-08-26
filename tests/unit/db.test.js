import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import db, {
  cleanupExpiredRooms,
  createRoom,
  deleteRoom,
  getActiveRoomBySlug,
  getRoomBySlug,
  roomExists,
  _resetDb
} from '../../src/lib/server/db.js'
import { getServerCopyRoomDir } from '../../src/lib/server/server-copy-storage.js'

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
})
