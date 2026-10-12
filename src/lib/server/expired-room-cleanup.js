import { cleanupExpiredRooms } from './db.js'

// The scheduler stays mounted so startup shape does not change.
// cleanupExpiredRooms deletes nothing (age must not destroy a room).
export const EXPIRED_ROOM_CLEANUP_INTERVAL_MS = 15 * 60 * 1000

export function runExpiredRoomCleanup({ logger = console } = {}) {
  const deleted = cleanupExpiredRooms()
  if (deleted > 0) logger.log(`[room-cleanup] removed ${deleted} expired room(s)`)
  return deleted
}

export function startExpiredRoomCleanup({
  intervalMs = EXPIRED_ROOM_CLEANUP_INTERVAL_MS,
  logger = console,
  runImmediately = true,
  setIntervalFn = setInterval
} = {}) {
  if (runImmediately) runExpiredRoomCleanup({ logger })
  const timer = setIntervalFn(() => runExpiredRoomCleanup({ logger }), intervalMs)
  timer?.unref?.()
  return timer
}
