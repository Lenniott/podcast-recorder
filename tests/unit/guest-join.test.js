import { closeSync, ftruncateSync, mkdirSync, openSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import db, {
  createRoom,
  getGuestLastAccess,
  getRoomBySlug,
  recordGuestAccess,
  _resetDb
} from '../../src/lib/server/db.js'
import { getServerCopyRoomDir } from '../../src/lib/server/server-copy-storage.js'
import {
  getGuestLockHours,
  getGuestLockInactivityHours,
  getGuestLockRecordingMinutes,
  guestJoinDecision,
  roomGuestLocked,
  unlockRoom
} from '../../src/lib/server/guest-join.js'

const SLUG = 'lockslug01'
const NOW = 1_700_000_000_000
const HOUR = 3_600_000
const ENV = {
  GUEST_LOCK_HOURS: '12',
  GUEST_LOCK_RECORDING_MINUTES: '10',
  GUEST_LOCK_INACTIVITY_HOURS: '2'
}
const SAMPLE_RATE = 48000

function wavBytes(seconds) {
  return 44 + Math.round(seconds * SAMPLE_RATE * 2)
}

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

function plantWav(name = 'client-a.wav', byteSize = 4) {
  const dir = getServerCopyRoomDir(SLUG)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  if (byteSize <= 4) {
    writeFileSync(file, Buffer.from([9, 8, 7, 6]))
    return
  }
  const fd = openSync(file, 'w')
  try {
    writeFileSync(fd, Buffer.alloc(Math.min(44, byteSize)))
    ftruncateSync(fd, byteSize)
  } finally {
    closeSync(fd)
  }
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

    it('defaults recording minutes to 10 and inactivity hours to 2', () => {
      expect(getGuestLockRecordingMinutes({})).toBe(10)
      expect(getGuestLockRecordingMinutes({ GUEST_LOCK_RECORDING_MINUTES: '' })).toBe(10)
      expect(getGuestLockRecordingMinutes({ GUEST_LOCK_RECORDING_MINUTES: '0' })).toBe(10)
      expect(getGuestLockRecordingMinutes({ GUEST_LOCK_RECORDING_MINUTES: '15' })).toBe(15)
      expect(getGuestLockInactivityHours({})).toBe(2)
      expect(getGuestLockInactivityHours({ GUEST_LOCK_INACTIVITY_HOURS: 'nope' })).toBe(2)
      expect(getGuestLockInactivityHours({ GUEST_LOCK_INACTIVITY_HOURS: '-1' })).toBe(2)
      expect(getGuestLockInactivityHours({ GUEST_LOCK_INACTIVITY_HOURS: '4' })).toBe(4)
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

    it('locks a long copy when last access is older than 2h, and allows the same guest once access is fresh', () => {
      plantWav('guest-a.wav', wavBytes(601))
      const room = roomAt(NOW - HOUR)
      recordGuestAccess(SLUG, 'guest-a', NOW - 3 * HOUR)
      expect(guestJoinDecision(room, { clientId: 'guest-a', now: NOW, env: ENV })).toEqual({
        allowed: false,
        reason: 'inactivity-lock'
      })
      recordGuestAccess(SLUG, 'guest-a', NOW - 30 * 60 * 1000)
      expect(guestJoinDecision(room, { clientId: 'guest-a', now: NOW, env: ENV })).toEqual({
        allowed: true,
        reason: 'ok'
      })
    })

    it('allows a copy at or just under 10 minutes when access is stale', () => {
      const room = roomAt(NOW - HOUR)
      recordGuestAccess(SLUG, 'guest-a', NOW - 3 * HOUR)
      plantWav('guest-a.wav', wavBytes(600) - 2)
      expect(guestJoinDecision(room, { clientId: 'guest-a', now: NOW, env: ENV })).toEqual({
        allowed: true,
        reason: 'ok'
      })
      plantWav('guest-a.wav', wavBytes(600))
      expect(guestJoinDecision(room, { clientId: 'guest-a', now: NOW, env: ENV })).toEqual({
        allowed: true,
        reason: 'ok'
      })
    })

    it('allows a copy just over 10 minutes when access is exactly 2h old, and locks one millisecond older', () => {
      plantWav('guest-a.wav', wavBytes(600) + 2)
      const room = roomAt(NOW - HOUR)
      recordGuestAccess(SLUG, 'guest-a', NOW - 2 * HOUR)
      expect(guestJoinDecision(room, { clientId: 'guest-a', now: NOW, env: ENV })).toEqual({
        allowed: true,
        reason: 'ok'
      })
      recordGuestAccess(SLUG, 'guest-a', NOW - 2 * HOUR - 1)
      expect(guestJoinDecision(room, { clientId: 'guest-a', now: NOW, env: ENV })).toEqual({
        allowed: false,
        reason: 'inactivity-lock'
      })
    })

    it('allows a host with stale access and a long copy', () => {
      plantWav('guest-a.wav', wavBytes(601))
      recordGuestAccess(SLUG, 'guest-a', NOW - 3 * HOUR)
      expect(guestJoinDecision(roomAt(NOW - HOUR), {
        isHost: true,
        clientId: 'guest-a',
        now: NOW,
        env: ENV
      })).toEqual({ allowed: true, reason: 'ok' })
    })

    it('allows a second guest without a long copy while the first is locked', () => {
      plantWav('guest-a.wav', wavBytes(601))
      plantWav('guest-b.wav', 4)
      const room = roomAt(NOW - HOUR)
      expect(guestJoinDecision(room, { clientId: 'guest-a', now: NOW, env: ENV })).toEqual({
        allowed: false,
        reason: 'inactivity-lock'
      })
      expect(guestJoinDecision(room, { clientId: 'guest-b', now: NOW, env: ENV })).toEqual({
        allowed: true,
        reason: 'ok'
      })
    })

    it('treats missing last access as stale once the copy is long enough', () => {
      plantWav('guest-a.wav', wavBytes(601))
      expect(getGuestLastAccess(SLUG, 'guest-a')).toBeNull()
      expect(guestJoinDecision(roomAt(NOW - HOUR), { clientId: 'guest-a', now: NOW, env: ENV })).toEqual({
        allowed: false,
        reason: 'inactivity-lock'
      })
    })

    it('sums every server copy for that clientId', () => {
      const half = wavBytes(300) + 2
      plantWav('guest-a__t1.wav', half)
      plantWav('guest-a__t2.wav', half)
      expect(guestJoinDecision(roomAt(NOW - HOUR), { clientId: 'guest-a', now: NOW, env: ENV })).toEqual({
        allowed: false,
        reason: 'inactivity-lock'
      })
    })

    it('keeps time-lock ahead of fresh access on a long copy', () => {
      plantWav('guest-a.wav', wavBytes(601))
      recordGuestAccess(SLUG, 'guest-a', NOW)
      expect(guestJoinDecision(roomAt(NOW - 13 * HOUR), {
        clientId: 'guest-a',
        now: NOW,
        env: ENV
      })).toEqual({ allowed: false, reason: 'time-lock' })
    })

    it('reports the room locked when any clientId is inactivity-locked on a fresh clock', () => {
      plantWav('guest-a.wav', wavBytes(601))
      plantWav('guest-b.wav', 4)
      const room = roomAt(NOW - HOUR)
      expect(roomGuestLocked(room, { now: NOW, env: ENV })).toBe(true)
      expect(guestJoinDecision(room, { now: NOW, env: ENV }).reason).toBe('ok')
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

    it('records last access now for a locked guest and leaves created_at unchanged', () => {
      const createdAt = 1_600_000_000_000
      createRoom({ slug: SLUG, name: 'Keep Me', passwordHash: 'hash-value', passwordPlain: 'pw' })
      db.getDb().prepare('UPDATE rooms SET created_at = ?, guest_lock_at = ? WHERE slug = ?')
        .run(createdAt, NOW - HOUR, SLUG)
      plantWav('guest-a.wav', wavBytes(601))
      recordGuestAccess(SLUG, 'guest-stored', NOW - 5 * HOUR)

      const before = getRoomBySlug(SLUG)
      expect(guestJoinDecision(before, { clientId: 'guest-a', now: NOW, env: ENV })).toEqual({
        allowed: false,
        reason: 'inactivity-lock'
      })

      expect(unlockRoom(SLUG, NOW)).toEqual({ ok: true })
      const after = getRoomBySlug(SLUG)
      expect(after.created_at).toBe(createdAt)
      expect(after.guest_lock_at).toBe(NOW)
      expect(after.name).toBe('Keep Me')
      expect(getGuestLastAccess(SLUG, 'guest-a')).toBe(NOW)
      expect(getGuestLastAccess(SLUG, 'guest-stored')).toBe(NOW)
      expect(guestJoinDecision(after, { clientId: 'guest-a', now: NOW, env: ENV })).toEqual({
        allowed: true,
        reason: 'ok'
      })
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
