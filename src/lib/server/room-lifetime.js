const DEFAULT_ROOM_MAX_AGE_HOURS = 12

export function getRoomMaxAgeHours(env = process.env) {
  const raw = Number.parseFloat(String(env.ROOM_MAX_AGE_HOURS || ''))
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ROOM_MAX_AGE_HOURS
}

export function getRoomMaxAgeMs(env = process.env) {
  return getRoomMaxAgeHours(env) * 60 * 60 * 1000
}

/**
 * Guest-lock clock. A finite `guest_lock_at` wins; a legacy row with a
 * null/missing clock is read as `created_at`. This does not delete a room.
 */
export function guestLockAt(room) {
  if (Number.isFinite(room?.guest_lock_at)) return room.guest_lock_at
  return room?.created_at
}

/**
 * Guest-lock clock vs ROOM_MAX_AGE_HOURS. A true result must not delete
 * the room or block the host — guest refusal is a later ticket.
 */
export function isRoomExpired(room, now = Date.now(), env = process.env) {
  if (!room) return true
  const clock = guestLockAt(room)
  if (!Number.isFinite(clock)) return true
  return now - clock > getRoomMaxAgeMs(env)
}
