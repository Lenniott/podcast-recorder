import { describe, it, expect } from 'vitest'
import {
  getRoomMaxAgeHours,
  getFriendRoomMaxAgeHours,
  getRoomMaxAgeMs,
  getFriendRoomMaxAgeMs,
  isRoomExpired
} from '../../src/lib/server/room-lifetime.js'

// friend-password-auth ticket 03, TDD seam 1: one expiry function,
// parameterized by room kind (the room's own `friend_room` flag) — not two
// near-duplicate copies. A Friend room's expiry must be governed by
// FRIEND_ROOM_MAX_AGE_HOURS regardless of ROOM_MAX_AGE_HOURS's value, and a
// Host room's expiry by ROOM_MAX_AGE_HOURS regardless of
// FRIEND_ROOM_MAX_AGE_HOURS's value.

const HOST_ROOM = { created_at: 0, friend_room: 0 }
const FRIEND_ROOM = { created_at: 0, friend_room: 1 }

describe('room-lifetime', () => {
  describe('getRoomMaxAgeHours / getFriendRoomMaxAgeHours', () => {
    it('each defaults to 12 when its own env var is unset', () => {
      expect(getRoomMaxAgeHours({})).toBe(12)
      expect(getFriendRoomMaxAgeHours({})).toBe(12)
    })

    it('each reads only its own env var, independently of the other', () => {
      const env = { ROOM_MAX_AGE_HOURS: '3', FRIEND_ROOM_MAX_AGE_HOURS: '30' }
      expect(getRoomMaxAgeHours(env)).toBe(3)
      expect(getFriendRoomMaxAgeHours(env)).toBe(30)
    })

    it('falls back to its own default on an invalid/zero/negative value, ignoring the other var', () => {
      const env = { ROOM_MAX_AGE_HOURS: 'nope', FRIEND_ROOM_MAX_AGE_HOURS: '-5' }
      expect(getRoomMaxAgeHours(env)).toBe(12)
      expect(getFriendRoomMaxAgeHours(env)).toBe(12)
    })

    it('getRoomMaxAgeMs / getFriendRoomMaxAgeMs convert hours to ms independently', () => {
      const env = { ROOM_MAX_AGE_HOURS: '1', FRIEND_ROOM_MAX_AGE_HOURS: '2' }
      expect(getRoomMaxAgeMs(env)).toBe(60 * 60 * 1000)
      expect(getFriendRoomMaxAgeMs(env)).toBe(2 * 60 * 60 * 1000)
    })
  })

  describe('isRoomExpired', () => {
    it('returns true for a null/undefined room', () => {
      expect(isRoomExpired(null)).toBe(true)
      expect(isRoomExpired(undefined)).toBe(true)
    })

    it('a Host room expires against ROOM_MAX_AGE_HOURS, regardless of FRIEND_ROOM_MAX_AGE_HOURS', () => {
      const env = { ROOM_MAX_AGE_HOURS: '1', FRIEND_ROOM_MAX_AGE_HOURS: '100' }
      const justUnder = 59 * 60 * 1000
      const justOver = 61 * 60 * 1000
      expect(isRoomExpired(HOST_ROOM, justUnder, env)).toBe(false)
      expect(isRoomExpired(HOST_ROOM, justOver, env)).toBe(true)
    })

    it('a Friend room expires against FRIEND_ROOM_MAX_AGE_HOURS, regardless of ROOM_MAX_AGE_HOURS', () => {
      const env = { ROOM_MAX_AGE_HOURS: '100', FRIEND_ROOM_MAX_AGE_HOURS: '1' }
      const justUnder = 59 * 60 * 1000
      const justOver = 61 * 60 * 1000
      expect(isRoomExpired(FRIEND_ROOM, justUnder, env)).toBe(false)
      expect(isRoomExpired(FRIEND_ROOM, justOver, env)).toBe(true)
    })

    it('a Host room past ROOM_MAX_AGE_HOURS is expired even when far inside FRIEND_ROOM_MAX_AGE_HOURS\'s window', () => {
      const env = { ROOM_MAX_AGE_HOURS: '1', FRIEND_ROOM_MAX_AGE_HOURS: '1000' }
      expect(isRoomExpired(HOST_ROOM, 2 * 60 * 60 * 1000, env)).toBe(true)
    })

    it('a Friend room past FRIEND_ROOM_MAX_AGE_HOURS is expired even when far inside ROOM_MAX_AGE_HOURS\'s window', () => {
      const env = { ROOM_MAX_AGE_HOURS: '1000', FRIEND_ROOM_MAX_AGE_HOURS: '1' }
      expect(isRoomExpired(FRIEND_ROOM, 2 * 60 * 60 * 1000, env)).toBe(true)
    })
  })
})
