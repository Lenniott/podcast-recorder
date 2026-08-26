const DEFAULT_ROOM_MAX_AGE_HOURS = 12

export function getRoomMaxAgeHours(env = process.env) {
  const raw = Number.parseFloat(String(env.ROOM_MAX_AGE_HOURS || ''))
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ROOM_MAX_AGE_HOURS
}

export function getRoomMaxAgeMs(env = process.env) {
  return getRoomMaxAgeHours(env) * 60 * 60 * 1000
}

export function isRoomExpired(room, now = Date.now(), env = process.env) {
  if (!room) return true
  return now - room.created_at > getRoomMaxAgeMs(env)
}
