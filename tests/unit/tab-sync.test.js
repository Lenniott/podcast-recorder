import { describe, it, expect } from 'vitest'
import { MAX_TABS, MAX_TAB_TEXT_LEN, nextTabTitle } from '../../src/lib/room/tab-sync.js'

describe('constants', () => {
  it('caps tab count and text length at sane, positive values', () => {
    expect(MAX_TABS).toBeGreaterThan(1)
    expect(MAX_TAB_TEXT_LEN).toBeGreaterThan(0)
  })
})

describe('nextTabTitle', () => {
  it.each([
    [[], 'Tab 1'],
    [['Tab 1'], 'Tab 2'],
    [['Tab 1', 'Tab 2'], 'Tab 3'],
    [['Tab 2'], 'Tab 1'],                 // fills the gap rather than always incrementing
    [['Tab 1', 'Tab 3'], 'Tab 2'],
    [['Custom name', 'Tab 1'], 'Tab 2'],  // ignores unrelated titles
  ])('given %j returns %s', (existingTitles, expected) => {
    expect(nextTabTitle(existingTitles)).toBe(expected)
  })

  it('defaults to no existing titles', () => {
    expect(nextTabTitle()).toBe('Tab 1')
  })
})
