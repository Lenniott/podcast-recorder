import { describe, expect, it } from 'vitest'
import {
  clearSelection,
  selectVisible,
  selectionCoversVisible,
  toggleSlug
} from '../../src/lib/home/room-selection.js'

const ROOMS = [
  { slug: 'room-a', name: 'Alpha' },
  { slug: 'room-b', name: 'Beta' },
  { slug: 'room-c', name: 'Gamma' }
]

describe('room selection', () => {
  it('toggles one slug on, then off, without mutating the input', () => {
    const start = []
    const on = toggleSlug(start, ROOMS[0].slug)
    expect(start).toEqual([])
    expect(on).toEqual(['room-a'])

    const off = toggleSlug(on, ROOMS[0].slug)
    expect(on).toEqual(['room-a'])
    expect(off).toEqual([])
  })

  it('selectVisible returns only the rooms passed in', () => {
    const visible = [ROOMS[0], ROOMS[2]]
    expect(selectVisible(visible)).toEqual(['room-a', 'room-c'])
    expect(selectVisible(visible)).not.toContain(ROOMS[1].slug)
  })

  it('clearSelection returns an empty array', () => {
    expect(clearSelection()).toEqual([])
  })

  it('selectionCoversVisible is false when a visible row is missing and true when every visible slug is selected', () => {
    const visible = [ROOMS[0], ROOMS[1]]
    expect(selectionCoversVisible(['room-a'], visible)).toBe(false)
    expect(selectionCoversVisible(['room-a', 'room-c'], visible)).toBe(false)
    expect(selectionCoversVisible(['room-a', 'room-b'], visible)).toBe(true)
    expect(selectionCoversVisible(['room-a', 'room-b', 'room-c'], visible)).toBe(true)
    expect(selectionCoversVisible(['room-a', 'room-b', 'room-c'], [])).toBe(false)
  })
})
