/**
 * Guest lock for one room. This module does not delete rooms.
 *
 * guestLockAt — the clock. A missing value is created_at. Unlock is the only writer.
 * guestJoinDecision — the only yes/no. The room page and the WebSocket both call it.
 * anyGuestLocked — dashboard row. True when any guest decision is a refusal.
 * noteAdmittedGuest — call only after a guest is actually in (authenticated
 *   page load or successful WebSocket join). A refused join must not call it.
 * unlockRoom — clock to now, and last access to now for every known clientId.
 *
 * Hosts (`isHost`) are always allowed. Until the room has server-known audio,
 * guests are allowed even when the clock is old. Inactivity is per clientId
 * (the id server copies use). A missing last-access row is stale.
 */
import { listServerCopyFiles, serverCopySeconds } from './server-copy-storage.js'
import { getGuestLastAccess, listGuestAccess, recordGuestAccess, setGuestLockAt } from './db.js'

const DEFAULT_GUEST_LOCK_HOURS = 12
const DEFAULT_GUEST_LOCK_RECORDING_MINUTES = 10
const DEFAULT_GUEST_LOCK_INACTIVITY_HOURS = 2

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

/** Finite guest_lock_at, otherwise created_at. Does not write. */
export function guestLockAt(room) {
  if (Number.isFinite(room?.guest_lock_at)) return room.guest_lock_at
  return room?.created_at
}

function serverCopies(slug) {
  try {
    return listServerCopyFiles(slug)
  } catch (err) {
    if (/Invalid room slug/.test(String(err?.message || err))) return []
    throw err
  }
}

function knownClientIds(slug, files) {
  const ids = new Set()
  for (const file of files) {
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
function decide(room, { isHost, clientId, now, env, files }) {
  if (!room) return { allowed: false, reason: 'missing-room' }
  if (isHost) return { allowed: true, reason: 'ok' }
  if (files.length === 0) return { allowed: true, reason: 'ok' }
  const ageMs = now - guestLockAt(room)
  if (ageMs > getGuestLockHours(env) * 3600000) {
    return { allowed: false, reason: 'time-lock' }
  }
  if (typeof clientId === 'string' && clientId !== '') {
    let seconds = 0
    for (const file of files) {
      if (file.clientId === clientId) seconds += serverCopySeconds(file)
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

export function guestJoinDecision(room, {
  isHost = false,
  clientId = null,
  now = Date.now(),
  env = process.env
} = {}) {
  const files = room ? serverCopies(room.slug) : []
  return decide(room, { isHost, clientId, now, env, files })
}

/**
 * True when a guest would be refused for any reason. A new refusal reason
 * from guestJoinDecision locks the row without another edit here.
 * Loads server copies once and reuses them for every clientId.
 */
export function anyGuestLocked(room, { now = Date.now(), env = process.env } = {}) {
  if (!room) return false
  const files = serverCopies(room.slug)
  if (!decide(room, { isHost: false, clientId: null, now, env, files }).allowed) return true
  for (const clientId of knownClientIds(room.slug, files)) {
    if (!decide(room, { isHost: false, clientId, now, env, files }).allowed) return true
  }
  return false
}

/**
 * Stamp a guest who got in. Hosts are not stamped. Empty ids are ignored.
 * Do not call this on a refusal — that would clear an inactivity lock.
 */
export function noteAdmittedGuest(slug, clientId, at = Date.now()) {
  if (!slug || typeof clientId !== 'string' || clientId === '') return
  recordGuestAccess(slug, clientId, at)
}

/**
 * Moves the guest-lock clock and records last access `at` for every
 * clientId with a server copy in the room and every clientId already
 * stored for the room. `created_at` is unchanged. A missing or unknown
 * slug does not throw.
 */
export function unlockRoom(slug, at = Date.now()) {
  if (slug == null || slug === '') return { ok: false }
  const files = serverCopies(slug)
  for (const clientId of knownClientIds(slug, files)) {
    recordGuestAccess(slug, clientId, at)
  }
  const changes = setGuestLockAt(slug, at)
  return { ok: changes > 0 }
}
