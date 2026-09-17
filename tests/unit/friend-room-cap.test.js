import { describe, it, expect, beforeEach } from 'vitest'
import db, { createRoom, _resetDb } from '../../src/lib/server/db.js'
import { getFriendRoomCapStatus, FRIEND_ROOM_CAP } from '../../src/lib/server/friend-room-cap.js'

// friend-password-auth ticket 03 — getFriendRoomCapStatus is the single
// source of truth for "is the Friend room cap full right now, and if so,
// what are the active rooms and their remaining time". TDD seams 2 and 3.

const ENV = { FRIEND_ROOM_MAX_AGE_HOURS: '12', ROOM_MAX_AGE_HOURS: '12' }

function makeFriendRoom(slug, createdAt) {
  createRoom({ slug, name: `Friend ${slug}`, passwordHash: 'hash', friendRoom: true })
  db.getDb().prepare('UPDATE rooms SET created_at = ? WHERE slug = ?').run(createdAt, slug)
}

function makeHostRoom(slug, createdAt) {
  createRoom({ slug, name: `Host ${slug}`, passwordHash: 'hash', friendRoom: false })
  db.getDb().prepare('UPDATE rooms SET created_at = ? WHERE slug = ?').run(createdAt, slug)
}

beforeEach(() => {
  process.env.DB_PATH = ':memory:'
  _resetDb()
})

describe('getFriendRoomCapStatus', () => {
  it('FRIEND_ROOM_CAP is 3', () => {
    expect(FRIEND_ROOM_CAP).toBe(3)
  })

  it('is not full with 0 active Friend rooms', () => {
    const status = getFriendRoomCapStatus(ENV, 0)
    expect(status.full).toBe(false)
    expect(status.rooms).toEqual([])
  })

  it('is not full with 2 active Friend rooms (boundary)', () => {
    makeFriendRoom('f1', 0)
    makeFriendRoom('f2', 0)
    const status = getFriendRoomCapStatus(ENV, 0)
    expect(status.full).toBe(false)
    expect(status.rooms).toHaveLength(2)
  })

  it('is full with exactly 3 active Friend rooms (boundary)', () => {
    makeFriendRoom('f1', 0)
    makeFriendRoom('f2', 0)
    makeFriendRoom('f3', 0)
    const status = getFriendRoomCapStatus(ENV, 0)
    expect(status.full).toBe(true)
    expect(status.rooms).toHaveLength(3)
  })

  it('is full with more than 3 active Friend rooms', () => {
    makeFriendRoom('f1', 0)
    makeFriendRoom('f2', 0)
    makeFriendRoom('f3', 0)
    makeFriendRoom('f4', 0)
    expect(getFriendRoomCapStatus(ENV, 0).full).toBe(true)
  })

  it('Host rooms never count toward the cap and never appear in the result', () => {
    makeHostRoom('h1', 0)
    makeHostRoom('h2', 0)
    makeHostRoom('h3', 0)
    makeHostRoom('h4', 0)
    const status = getFriendRoomCapStatus(ENV, 0)
    expect(status.full).toBe(false)
    expect(status.rooms).toEqual([])
  })

  it('an expired Friend room does not count toward the cap', () => {
    const twelveHoursMs = 12 * 60 * 60 * 1000
    makeFriendRoom('f1', 0) // now expired at `now`
    makeFriendRoom('f2', twelveHoursMs) // fresh
    makeFriendRoom('f3', twelveHoursMs)
    const status = getFriendRoomCapStatus(ENV, twelveHoursMs + 1)
    expect(status.full).toBe(false)
    expect(status.rooms.map((r) => r.slug)).toEqual(['f2', 'f3'])
  })

  it('lists active rooms soonest-to-expire first (the oldest-created room, on a shared clock, expires soonest)', () => {
    makeFriendRoom('oldest', 1000)
    makeFriendRoom('newest', 3000)
    makeFriendRoom('middle', 2000)
    const status = getFriendRoomCapStatus(ENV, 5000)
    expect(status.rooms.map((r) => r.slug)).toEqual(['oldest', 'middle', 'newest'])
  })

  it('computes expiresAt from the Friend clock (FRIEND_ROOM_MAX_AGE_HOURS), not the Host one', () => {
    const env = { FRIEND_ROOM_MAX_AGE_HOURS: '1', ROOM_MAX_AGE_HOURS: '100' }
    makeFriendRoom('f1', 0)
    const status = getFriendRoomCapStatus(env, 0)
    expect(status.rooms[0].expiresAt).toBe(60 * 60 * 1000)
  })

  it('the race case: a stale earlier read must not block a create once a room has actually expired', () => {
    const twelveHoursMs = 12 * 60 * 60 * 1000
    makeFriendRoom('f1', 0)
    makeFriendRoom('f2', 0)
    makeFriendRoom('f3', 0)

    // An earlier read (e.g. taken for an unrelated purpose) sees the cap
    // full at time 0 — but the function is never handed that stale result;
    // every call re-derives its own answer from the current time.
    expect(getFriendRoomCapStatus(ENV, 0).full).toBe(true)

    // By the time of the actual create attempt, all three have expired.
    const afterExpiry = twelveHoursMs + 1
    const status = getFriendRoomCapStatus(ENV, afterExpiry)
    expect(status.full).toBe(false)
    expect(status.rooms).toEqual([])
  })
})
