import { describe, it, expect, vi } from 'vitest'

vi.mock('../../src/lib/server/db.js', () => ({
  cleanupExpiredRooms: vi.fn(() => 0)
}))

import { cleanupExpiredRooms } from '../../src/lib/server/db.js'
import {
  EXPIRED_ROOM_CLEANUP_INTERVAL_MS,
  runExpiredRoomCleanup,
  startExpiredRoomCleanup
} from '../../src/lib/server/expired-room-cleanup.js'

describe('expired room cleanup scheduler', () => {
  it('runs an immediate cleanup and schedules recurring cleanup', () => {
    const logger = { log: vi.fn() }
    const timer = { unref: vi.fn() }
    const setIntervalFn = vi.fn(() => timer)

    const returned = startExpiredRoomCleanup({ logger, setIntervalFn })

    expect(cleanupExpiredRooms).toHaveBeenCalledTimes(1)
    expect(setIntervalFn).toHaveBeenCalledTimes(1)
    expect(setIntervalFn.mock.calls[0][1]).toBe(EXPIRED_ROOM_CLEANUP_INTERVAL_MS)
    expect(timer.unref).toHaveBeenCalledTimes(1)
    expect(returned).toBe(timer)

    setIntervalFn.mock.calls[0][0]()
    expect(cleanupExpiredRooms).toHaveBeenCalledTimes(2)
  })

  it('logs only when cleanup actually deletes rooms', () => {
    const logger = { log: vi.fn() }
    cleanupExpiredRooms.mockReturnValueOnce(2)

    expect(runExpiredRoomCleanup({ logger })).toBe(2)

    expect(logger.log).toHaveBeenCalledWith('[room-cleanup] removed 2 expired room(s)')
  })
})
