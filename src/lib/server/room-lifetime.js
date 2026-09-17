const DEFAULT_ROOM_MAX_AGE_HOURS = 12
const DEFAULT_FRIEND_ROOM_MAX_AGE_HOURS = 12

function parsePositiveHours(raw, fallback) {
  const parsed = Number.parseFloat(String(raw || ''))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/** Host room expiry clock — `ROOM_MAX_AGE_HOURS`. Completely unaffected by
 *  `FRIEND_ROOM_MAX_AGE_HOURS` (see `getFriendRoomMaxAgeHours` below) —
 *  friend-password-auth ticket 03, TDD seam 1. */
export function getRoomMaxAgeHours(env = process.env) {
  return parsePositiveHours(env.ROOM_MAX_AGE_HOURS, DEFAULT_ROOM_MAX_AGE_HOURS)
}

/**
 * Friend room expiry clock (friend-password-auth ticket 03) — its own env
 * var, `FRIEND_ROOM_MAX_AGE_HOURS`, with its own independent default.
 * Completely unaffected by `ROOM_MAX_AGE_HOURS`, and vice versa — the two
 * clocks share this module's parsing shape but never each other's value.
 */
export function getFriendRoomMaxAgeHours(env = process.env) {
  return parsePositiveHours(env.FRIEND_ROOM_MAX_AGE_HOURS, DEFAULT_FRIEND_ROOM_MAX_AGE_HOURS)
}

/**
 * Which clock applies to `room` — decided by the room's own `friend_room`
 * flag, never by who's asking. One parameterized lookup rather than a
 * second near-duplicate "is it expired" copy for Friend rooms (ticket 03,
 * TDD seam 1) — `isRoomExpired` below is the only thing that needs this.
 */
export function getRoomMaxAgeHoursFor(room, env = process.env) {
  return room?.friend_room ? getFriendRoomMaxAgeHours(env) : getRoomMaxAgeHours(env)
}

export function getRoomMaxAgeMs(env = process.env) {
  return getRoomMaxAgeHours(env) * 60 * 60 * 1000
}

export function getFriendRoomMaxAgeMs(env = process.env) {
  return getFriendRoomMaxAgeHours(env) * 60 * 60 * 1000
}

/**
 * `room` is expired once it's older than the clock that applies to *its own
 * kind* — a Friend room (`friend_room` truthy) is checked against
 * `FRIEND_ROOM_MAX_AGE_HOURS` regardless of `ROOM_MAX_AGE_HOURS`'s value,
 * and a Host room is checked against `ROOM_MAX_AGE_HOURS` regardless of
 * `FRIEND_ROOM_MAX_AGE_HOURS`'s value. Same function either way — see
 * `getRoomMaxAgeHoursFor`.
 */
export function isRoomExpired(room, now = Date.now(), env = process.env) {
  if (!room) return true
  const maxAgeMs = getRoomMaxAgeHoursFor(room, env) * 60 * 60 * 1000
  return now - room.created_at > maxAgeMs
}
