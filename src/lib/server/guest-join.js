/**
 * Guest join gate shared by the room page (load, enter, set_display_name)
 * and the room WebSocket. Time lock and inactivity lock are both decided
 * here. This never deletes a room and never records access — callers
 * record after a successful join.
 *
 * Hosts (`isHost`) are always allowed. Until the room has server-known
 * audio, guests are allowed even when the guest-lock clock is old.
 *
 * Inactivity lock is per clientId (the same id server copies use). A
 * missing last-access row is stale: once that guest's own server copies
 * are longer than the recording threshold, they are locked.
 */
import { listServerCopyFiles } from './server-copy-storage.js'
import { guestLockAt } from './room-lifetime.js'
import { getGuestLastAccess, listGuestAccess, recordGuestAccess, setGuestLockAt } from './db.js'

const DEFAULT_GUEST_LOCK_HOURS = 12
const DEFAULT_GUEST_LOCK_RECORDING_MINUTES = 10
const DEFAULT_GUEST_LOCK_INACTIVITY_HOURS = 2
const DEFAULT_SAMPLE_RATE = 48000
const BYTES_PER_SAMPLE = 2

function positiveNumber(raw, fallback) {
  const value = Number.parseFloat(String(raw || ''))
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export function getGuestLockHours(env = process.env) {
  return positiveNumber(env.GUEST_LOCK_HOURS, DEFAULT_GUEST_LOCK_HOURS)
}

export function getGuestLockRecordingMinutes(env = process.env) {
  return positiveNumber(env.GUEST_LOCK_RECORDING_MINUTES, DEFAULT_GUEST_LOCK_RECORDING_MINUTES)
}

export function getGuestLockInactivityHours(env = process.env) {
  return positiveNumber(env.GUEST_LOCK_INACTIVITY_HOURS, DEFAULT_GUEST_LOCK_INACTIVITY_HOURS)
}

function copySeconds(file) {
  const sampleRate = Number.isFinite(file.sampleRate) && file.sampleRate > 0
    ? file.sampleRate
    : DEFAULT_SAMPLE_RATE
  return Math.max(0, file.byteSize - 44) / (sampleRate * BYTES_PER_SAMPLE)
}

function serverCopies(slug) {
  try {
    return listServerCopyFiles(slug)
  } catch (err) {
    if (/Invalid room slug/.test(String(err?.message || err))) return []
    throw err
  }
}

function clientIdsForRoom(slug) {
  const ids = new Set()
  for (const file of serverCopies(slug)) {
    if (file.clientId) ids.add(file.clientId)
  }
  for (const row of listGuestAccess(slug)) {
    if (row.clientId) ids.add(row.clientId)
  }
  return ids
}

/**
 * @returns {{ allowed: boolean, reason: 'ok' | 'missing-room' | 'time-lock' | 'inactivity-lock' }}
 */
export function guestJoinDecision(room, {
  isHost = false,
  clientId = null,
  now = Date.now(),
  env = process.env
} = {}) {
  if (!room) return { allowed: false, reason: 'missing-room' }
  if (isHost) return { allowed: true, reason: 'ok' }
  const files = serverCopies(room.slug)
  if (files.length === 0) return { allowed: true, reason: 'ok' }
  const ageMs = now - guestLockAt(room)
  if (ageMs > getGuestLockHours(env) * 3600000) {
    return { allowed: false, reason: 'time-lock' }
  }
  if (typeof clientId === 'string' && clientId !== '') {
    let seconds = 0
    for (const file of files) {
      if (file.clientId === clientId) seconds += copySeconds(file)
    }
    const lastAccess = getGuestLastAccess(room.slug, clientId)
    // No recorded access is stale. An age equal to the window stays allowed.
    const inactive = lastAccess == null || now - lastAccess > getGuestLockInactivityHours(env) * 3600000
    if (seconds > getGuestLockRecordingMinutes(env) * 60 && inactive) {
      return { allowed: false, reason: 'inactivity-lock' }
    }
  }
  return { allowed: true, reason: 'ok' }
}

/**
 * True when a guest with no clientId would hit the time lock, or any
 * clientId that has a server copy or a stored access row would hit the
 * time lock or the inactivity lock. A room must not look open to guests
 * while any of those guests is locked.
 */
export function roomGuestLocked(room, { now = Date.now(), env = process.env } = {}) {
  if (!room) return false
  if (guestJoinDecision(room, { isHost: false, now, env }).reason === 'time-lock') return true
  for (const clientId of clientIdsForRoom(room.slug)) {
    const reason = guestJoinDecision(room, { isHost: false, clientId, now, env }).reason
    if (reason === 'inactivity-lock' || reason === 'time-lock') return true
  }
  return false
}

/**
 * Moves the guest-lock clock and records last access `now` for every
 * clientId with a server copy in the room and every clientId already
 * stored for the room. `created_at` is unchanged. A missing or unknown
 * slug does not throw.
 */
export function unlockRoom(slug, now = Date.now()) {
  if (slug == null || slug === '') return { ok: false }
  for (const clientId of clientIdsForRoom(slug)) {
    recordGuestAccess(slug, clientId, now)
  }
  const changes = setGuestLockAt(slug, now)
  return { ok: changes > 0 }
}
