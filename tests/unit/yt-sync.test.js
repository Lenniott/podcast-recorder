import { describe, it, expect } from 'vitest'
import { parseYouTubeId, effectivePosition } from '../../src/lib/yt-sync.js'

describe('parseYouTubeId', () => {
  const ID = 'dQw4w9WgXcQ'

  it.each([
    [`https://www.youtube.com/watch?v=${ID}`, ID],
    [`https://youtube.com/watch?v=${ID}&t=42s`, ID],
    [`http://m.youtube.com/watch?v=${ID}`, ID],
    [`https://youtu.be/${ID}`, ID],
    [`https://youtu.be/${ID}?si=share-junk`, ID],
    [`https://www.youtube.com/shorts/${ID}`, ID],
    [`https://www.youtube.com/embed/${ID}`, ID],
    [`https://www.youtube.com/live/${ID}`, ID],
    [`www.youtube.com/watch?v=${ID}`, ID],        // no protocol
    [ID, ID],                                     // raw id
    [`  ${ID}  `, ID]                             // whitespace
  ])('parses %s', (input, expected) => {
    expect(parseYouTubeId(input)).toBe(expected)
  })

  it.each([
    [''],
    ['   '],
    ['not a url'],
    ['https://vimeo.com/12345678901'],
    ['https://www.youtube.com/watch?v=tooshort'],
    ['https://www.youtube.com/watch'],
    ['https://evil.com/watch?v=dQw4w9WgXcQ'],     // wrong host
    ['javascript:alert(1)'],
    [null],
    [undefined]
  ])('rejects %s', (input) => {
    expect(parseYouTubeId(input)).toBe(null)
  })
})

describe('effectivePosition', () => {
  it('stays put when paused', () => {
    const state = { playing: false, positionSec: 30, positionAtMs: 1000 }
    expect(effectivePosition(state, 99_000)).toBe(30)
  })

  it('advances with elapsed server time when playing', () => {
    const state = { playing: true, positionSec: 30, positionAtMs: 1000 }
    expect(effectivePosition(state, 5000)).toBe(34)   // +4s elapsed
  })

  it('never rewinds before positionSec when positionAtMs is in the future', () => {
    // Fresh command: positionAtMs === triggerAtMs, slightly ahead of "now"
    const state = { playing: true, positionSec: 30, positionAtMs: 2000 }
    expect(effectivePosition(state, 1500)).toBe(30)
  })
})
