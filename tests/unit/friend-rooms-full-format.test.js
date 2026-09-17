import { describe, it, expect } from 'vitest'
import { formatRemaining } from '../../src/lib/home/friend-rooms-full.js'

describe('formatRemaining', () => {
  it('renders whole hours with no minutes remainder as just hours', () => {
    expect(formatRemaining(2 * 60 * 60 * 1000)).toBe('2h')
  })

  it('renders hours and minutes together', () => {
    expect(formatRemaining(2 * 60 * 60 * 1000 + 15 * 60 * 1000)).toBe('2h 15m')
  })

  it('renders minutes only under an hour', () => {
    expect(formatRemaining(45 * 60 * 1000)).toBe('45m')
  })

  it('rounds a partial minute up so it never reads as already-expired', () => {
    expect(formatRemaining(90 * 1000)).toBe('2m')
  })

  it('renders "less than a minute" for very small remaining time', () => {
    expect(formatRemaining(1000)).toBe('less than a minute')
  })

  it('clamps negative durations to "less than a minute" rather than a negative value', () => {
    expect(formatRemaining(-5000)).toBe('less than a minute')
  })

  it('zero is "less than a minute"', () => {
    expect(formatRemaining(0)).toBe('less than a minute')
  })
})
