import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import db, { createRoom, getRoomBySlug, _resetDb } from '../../src/lib/server/db.js'
import { getServerCopyRoomDir } from '../../src/lib/server/server-copy-storage.js'
import { getGuestLockHours, guestJoinDecision, unlockRoom } from '../../src/lib/server/guest-join.js'

const SLUG = 'lockslug01'
const NOW = 1_700_000_000_000
const HOUR = 3_600_000
const ENV = { GUEST_LOCK_HOURS: '12' }

function roomAt(guestLockAt, createdAt = guestLockAt - 48 * HOUR) {
  return {
    slug: SLUG,
    name: 'Keep Me',
    password_hash: 'hash-value',
    password_plain: 'pw',
    created_at: createdAt,
    guest_lock_at: guestLockAt
  }
}

function plantWav(name = 'client-a.wav') {
  const dir = getServerCopyRoomDir(SLUG)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), Buffer.from([9, 8, 7, 6]))
}

describe('guest join', () => {
  let serverCopyDir

  beforeEach(() => {
    serverCopyDir = join(
      tmpdir(),
      `guest-join-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
    process.env.DB_PATH = ':memory:'
    process.env.SERVER_COPY_DIR = serverCopyDir
    process.env.SECRET = 'test-secret-do-not-use-in-prod'
    _resetDb()
  })

  afterEach(() => {
    if (serverCopyDir) rmSync(serverCopyDir, { recursive: true, force: true })
  })

  describe('getGuestLockHours', () => {
    it('defaults to 12 when missing or invalid', () => {
      expect(getGuestLockHours({})).toBe(12)
      expect(getGuestLockHours({ GUEST_LOCK_HOURS: '' })).toBe(12)
      expect(getGuestLockHours({ GUEST_LOCK_HOURS: 'nope' })).toBe(12)
      expect(getGuestLockHours({ GUEST_LOCK_HOURS: '0' })).toBe(12)
      expect(getGuestLockHours({ GUEST_LOCK_HOURS: '-4' })).toBe(12)
      expect(getGuestLockHours({ GUEST_LOCK_HOURS: '6' })).toBe(6)
    })
  })

  describe('guestJoinDecision', () => {
    it('refuses a missing room', () => {
      expect(guestJoinDecision(null, { isHost: true, now: NOW, env: ENV })).toEqual({
        allowed: false,
        reason: 'missing-room'
      })
      expect(guestJoinDecision(undefined, { now: NOW, env: ENV })).toEqual({
        allowed: false,
        reason: 'missing-room'
      })
    })

    it('allows a guest when there is no server audio, even if the clock is 13h old', () => {
      const decision = guestJoinDecision(roomAt(NOW - 13 * HOUR), { now: NOW, env: ENV })
      expect(decision).toEqual({ allowed: true, reason: 'ok' })
    })

    it('allows a host with no server audio and an old clock', () => {
      const decision = guestJoinDecision(roomAt(NOW - 13 * HOUR), { isHost: true, now: NOW, env: ENV })
      expect(decision).toEqual({ allowed: true, reason: 'ok' })
    })

    it('refuses a guest and allows a host when server audio exists and the clock is 13h old', () => {
      plantWav()
      const room = roomAt(NOW - 13 * HOUR)
      expect(guestJoinDecision(room, { now: NOW, env: ENV })).toEqual({
        allowed: false,
        reason: 'time-lock'
      })
      expect(guestJoinDecision(room, { isHost: true, now: NOW, env: ENV })).toEqual({
        allowed: true,
        reason: 'ok'
      })
    })

    it('allows a guest when server audio exists and the clock is 1h old', () => {
      plantWav()
      const room = roomAt(NOW - HOUR)
      expect(guestJoinDecision(room, { now: NOW, env: ENV })).toEqual({ allowed: true, reason: 'ok' })
      expect(guestJoinDecision(room, { isHost: true, now: NOW, env: ENV })).toEqual({
        allowed: true,
        reason: 'ok'
      })
    })

    it('allows an age equal to exactly 12h and locks 12h+1ms', () => {
      plantWav()
      const exact = guestJoinDecision(roomAt(NOW - 12 * HOUR), { now: NOW, env: ENV })
      expect(exact).toEqual({ allowed: true, reason: 'ok' })
      const justOver = guestJoinDecision(roomAt(NOW - 12 * HOUR - 1), { now: NOW, env: ENV })
      expect(justOver).toEqual({ allowed: false, reason: 'time-lock' })
    })

    it('treats a null guest_lock_at as created_at', () => {
      plantWav()
      const decision = guestJoinDecision(
        { slug: SLUG, created_at: NOW - 13 * HOUR, guest_lock_at: null },
        { now: NOW, env: ENV }
      )
      expect(decision).toEqual({ allowed: false, reason: 'time-lock' })
    })

    it('uses GUEST_LOCK_HOURS rather than ROOM_MAX_AGE_HOURS', () => {
      plantWav()
      const decision = guestJoinDecision(roomAt(NOW - 2 * HOUR), {
        now: NOW,
        env: { GUEST_LOCK_HOURS: '12', ROOM_MAX_AGE_HOURS: '1' }
      })
      expect(decision).toEqual({ allowed: true, reason: 'ok' })
    })
  })

  describe('unlockRoom', () => {
    it('moves guest_lock_at to the passed now and leaves created_at, name, and password', () => {
      const createdAt = 1_600_000_000_000
      const oldLock = NOW - 13 * HOUR
      createRoom({
        slug: SLUG,
        name: 'Keep Me',
        passwordHash: 'hash-value',
        passwordPlain: 'pw'
      })
      db.getDb().prepare(
        'UPDATE rooms SET created_at = ?, guest_lock_at = ?, name = ?, password_hash = ?, password_plain = ? WHERE slug = ?'
      ).run(createdAt, oldLock, 'Keep Me', 'hash-value', 'pw', SLUG)
      plantWav()

      const before = getRoomBySlug(SLUG)
      expect(guestJoinDecision(before, { now: NOW, env: ENV })).toEqual({
        allowed: false,
        reason: 'time-lock'
      })

      expect(unlockRoom(SLUG, NOW)).toEqual({ ok: true })
      const after = getRoomBySlug(SLUG)
      expect(after.guest_lock_at).toBe(NOW)
      expect(after.created_at).toBe(createdAt)
      expect(after.slug).toBe(SLUG)
      expect(after.name).toBe('Keep Me')
      expect(after.password_hash).toBe('hash-value')
      expect(after.password_plain).toBe('pw')
      expect(guestJoinDecision(after, { now: NOW, env: ENV })).toEqual({ allowed: true, reason: 'ok' })
    })

    it('moves the clock on a room that is still open to guests', () => {
      const createdAt = 1_600_000_000_000
      createRoom({ slug: SLUG, name: 'Keep Me', passwordHash: 'hash-value', passwordPlain: 'pw' })
      db.getDb().prepare('UPDATE rooms SET created_at = ?, guest_lock_at = ? WHERE slug = ?')
        .run(createdAt, NOW - HOUR, SLUG)

      expect(unlockRoom(SLUG, NOW)).toEqual({ ok: true })
      const after = getRoomBySlug(SLUG)
      expect(after.guest_lock_at).toBe(NOW)
      expect(after.created_at).toBe(createdAt)
    })

    it('returns { ok: false } for an unknown or missing slug and does not throw', () => {
      expect(() => unlockRoom('no-such-slug', NOW)).not.toThrow()
      expect(unlockRoom('no-such-slug', NOW)).toEqual({ ok: false })
      expect(unlockRoom('', NOW)).toEqual({ ok: false })
      expect(unlockRoom(undefined, NOW)).toEqual({ ok: false })
      expect(getRoomBySlug('no-such-slug')).toBeNull()
    })
  })
})
