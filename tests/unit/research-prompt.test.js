import { describe, expect, it } from 'vitest'
import { isCustomEnabled } from '../../src/lib/home/research-prompt.js'

describe('isCustomEnabled', () => {
  it('is off when the Research Prompt is empty', () => {
    expect(isCustomEnabled('', 'Interpret')).toBe(false)
    expect(isCustomEnabled('   ', 'Interpret')).toBe(false)
  })

  it('is off when the Research Prompt Title is empty', () => {
    expect(isCustomEnabled('Read {current_tab}.', '')).toBe(false)
    expect(isCustomEnabled('Read {current_tab}.', '   ')).toBe(false)
  })

  it('is on only when both title and prompt have text', () => {
    expect(isCustomEnabled('Read {current_tab}.', 'Interpret')).toBe(true)
  })
})
