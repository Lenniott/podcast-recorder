/**
 * Guest join gate shared by the room page (load, enter, set_display_name)
 * and the room WebSocket. A later inactivity rule extends this decision
 * instead of adding a second gate. This never deletes a room.
 *
 * Hosts (`isHost`) are always allowed. Until the room has server-known
 * audio, guests are allowed even when the guest-lock clock is old.
 */
import { listServerCopyFiles } from './server-copy-storage.js'
import { guestLockAt } from './room-lifetime.js'
import { setGuestLockAt } from './db.js'

const DEFAULT_GUEST_LOCK_HOURS = 12

export function getGuestLockHours(env = process.env) {
  const raw = Number.parseFloat(String(env.GUEST_LOCK_HOURS || ''))
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_GUEST_LOCK_HOURS
}

/**
 * @returns {{ allowed: boolean, reason: 'ok' | 'missing-room' | 'time-lock' }}
 */
export function guestJoinDecision(room, { isHost = false, now = Date.now(), env = process.env } = {}) {
  if (!room) return { allowed: false, reason: 'missing-room' }
  if (isHost) return { allowed: true, reason: 'ok' }
  if (listServerCopyFiles(room.slug).length === 0) return { allowed: true, reason: 'ok' }
  const ageMs = now - guestLockAt(room)
  if (ageMs > getGuestLockHours(env) * 3600000) {
    return { allowed: false, reason: 'time-lock' }
  }
  return { allowed: true, reason: 'ok' }
}

/** Moves only the guest-lock clock. A missing or unknown slug does not throw. */
export function unlockRoom(slug, now = Date.now()) {
  if (slug == null || slug === '') return { ok: false }
  const changes = setGuestLockAt(slug, now)
  return { ok: changes > 0 }
}
