import { describe, it, expect } from 'vitest'
import {
  countOccurrences,
  locateQuoteTurn,
  turnHighlightSegments
} from '../../src/lib/room/turn-highlights.js'
import { needsQuoteRematch } from '../../src/lib/room/notes-highlights.js'
import { TRANSCRIPT_TAB_ID } from '../../src/lib/room/transcript-sync.js'

const turn = (id, text, speaker = 'Host') => ({ id, speaker, text, at: 1 })
const annotation = (id, quote) => ({ id, tabId: TRANSCRIPT_TAB_ID, kind: 'comment', quote, text: 'note', author: 'Host', at: 1 })

const LINES = [
  turn('t1', 'Welcome to the show.'),
  turn('t2', 'Thanks for having me.', 'Guest'),
  turn('t3', 'Let us talk about the summer.')
]

describe('countOccurrences', () => {
  it('counts every occurrence, not just the first', () => {
    expect(countOccurrences('ab ab ab', 'ab')).toBe(3)
  })

  it('is zero for a miss, an empty needle or an empty haystack', () => {
    expect(countOccurrences('hello', 'bye')).toBe(0)
    expect(countOccurrences('hello', '')).toBe(0)
    expect(countOccurrences('', 'hello')).toBe(0)
    expect(countOccurrences(null, undefined)).toBe(0)
  })
})

describe('locateQuoteTurn — which Turn a frozen quote came from', () => {
  it('finds the one Turn containing the quote', () => {
    expect(locateQuoteTurn(LINES, 'having me')).toBe('t2')
  })

  it('refuses to guess when the quote occurs in more than one Turn', () => {
    // "the" is in t1 and t3 — drawing it on either would put a highlight
    // somewhere nobody highlighted.
    expect(locateQuoteTurn(LINES, 'the')).toBe(null)
  })

  it('refuses to guess when the quote occurs twice inside ONE Turn', () => {
    const lines = [turn('t1', 'really really good')]
    expect(locateQuoteTurn(lines, 'really')).toBe(null)
  })

  it('is null for a quote that is nowhere in the Transcript', () => {
    expect(locateQuoteTurn(LINES, 'never said this')).toBe(null)
  })

  it('is null for an empty quote or an empty Transcript', () => {
    expect(locateQuoteTurn(LINES, '')).toBe(null)
    expect(locateQuoteTurn([], 'anything')).toBe(null)
    expect(locateQuoteTurn(null, 'anything')).toBe(null)
  })
})

describe('turnHighlightSegments — drawing Turn-anchored Annotations', () => {
  it('returns one entry per Turn, in the order given, always', () => {
    const out = turnHighlightSegments(LINES, [])
    expect(out.map((t) => t.id)).toEqual(['t1', 't2', 't3'])
  })

  it('reproduces every Turn s text exactly, highlighted or not', () => {
    const out = turnHighlightSegments(LINES, [annotation('a1', 'having me')])
    for (let i = 0; i < LINES.length; i++) {
      expect(out[i].segments.map((s) => s.text).join('')).toBe(LINES[i].text)
    }
  })

  it('tags only the matched span, and only on the Turn it came from', () => {
    const out = turnHighlightSegments(LINES, [annotation('a1', 'having me')])
    const t2 = out.find((t) => t.id === 't2')
    expect(t2.segments.find((s) => s.ids.includes('a1')).text).toBe('having me')
    // No other Turn gets a mark.
    for (const other of out.filter((t) => t.id !== 't2')) {
      expect(other.segments.every((s) => s.ids.length === 0)).toBe(true)
    }
  })

  it('draws nothing at all for an ambiguous quote — no highlight beats a wrong one', () => {
    const out = turnHighlightSegments(LINES, [annotation('a1', 'the')])
    for (const t of out) {
      expect(t.segments.every((s) => s.ids.length === 0)).toBe(true)
    }
    // The Annotation still exists; it just gets no highlight. That is the
    // same honest outcome notes-highlights.js gives an edited-away quote.
  })

  it('draws two Annotations on the same Turn independently', () => {
    const out = turnHighlightSegments(LINES, [
      annotation('a1', 'Welcome'),
      annotation('a2', 'show')
    ])
    const t1 = out.find((t) => t.id === 't1')
    const ids = t1.segments.flatMap((s) => s.ids)
    expect(ids).toContain('a1')
    expect(ids).toContain('a2')
  })

  it('survives a blank Turn and an annotation with no quote', () => {
    const out = turnHighlightSegments([turn('t1', '')], [{ id: 'a1' }, annotation('a2', '')])
    expect(out).toHaveLength(1)
    expect(out[0].segments.map((s) => s.text).join('')).toBe('')
  })

  it('needs no re-match gate — a Turn is append-only, so its quote cannot go stale', () => {
    // The escape hatch ticket 04 left for this ticket: Turn-anchored
    // Annotations are excluded from the Notes edit-survival path entirely,
    // and this module is what replaces it.
    expect(needsQuoteRematch(TRANSCRIPT_TAB_ID)).toBe(false)
    expect(needsQuoteRematch('tab-1')).toBe(true)
  })
})
