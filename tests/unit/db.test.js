import { describe, it, expect, beforeEach } from 'vitest'
import { createRoom, getRoomBySlug, roomExists, _resetDb } from '../../src/lib/server/db.js'

// Fresh in-memory DB before each test (DB_PATH=':memory:' set in setup.js)
beforeEach(() => _resetDb())

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
})
