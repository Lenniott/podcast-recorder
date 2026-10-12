import { describe, it, expect } from 'vitest'
import { filterRooms, roomEnterPath, formatRoomCreatedAt } from '../../src/lib/home/room-table-filter.js'

const rooms = [
  { name: 'Alpha Episode', slug: 'alpha-slug', createdAt: 1 },
  { name: 'Beta Show', slug: 'beta-slug', createdAt: 2 }
]

describe('filterRooms', () => {
  it('substring of name shows only that room', () => {
    const input = rooms.map((room) => ({ ...room }))
    expect(filterRooms(input, 'aLpH')).toEqual([input[0]])
    expect(input).toEqual(rooms)
  })

  it('substring of slug shows only that room', () => {
    expect(filterRooms(rooms, 'BeTa-SL')).toEqual([rooms[1]])
  })

  it('empty query and whitespace show all', () => {
    expect(filterRooms(rooms, '')).toEqual(rooms)
    expect(filterRooms(rooms, '   ')).toEqual(rooms)
  })

  it('query with no hits returns []', () => {
    expect(filterRooms(rooms, 'zzz-no-such-room')).toEqual([])
  })
})

describe('roomEnterPath', () => {
  it('builds the room URL', () => {
    expect(roomEnterPath('abc')).toBe('/rec/abc')
  })
})

describe('formatRoomCreatedAt', () => {
  it('formats an unambiguous UTC timestamp', () => {
    expect(formatRoomCreatedAt(Date.UTC(2026, 0, 2, 15, 4))).toBe('2 Jan 2026, 15:04 UTC')
  })
})
