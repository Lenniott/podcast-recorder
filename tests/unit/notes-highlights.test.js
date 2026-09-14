import { describe, it, expect } from 'vitest'
import {
  highlightSegments,
  locateQuote,
  matchedAnnotationIds,
  needsQuoteRematch
} from '../../src/lib/room/notes-highlights.js'
import { TRANSCRIPT_TAB_ID } from '../../src/lib/room/transcript-sync.js'
import { visibleAnnotations } from '../../src/lib/research/annotation-panel.js'

const annotation = (id, quote, over = {}) => ({
  id,
  tabId: 'tab-1',
  kind: 'comment',
  quote,
  text: 'a note',
  author: 'Host',
  at: 1000,
  ...over
})

/** What the layer actually paints: the highlighted substrings, in order. */
const highlighted = (text, annotations) =>
  highlightSegments(text, annotations)
    .filter((s) => s.ids.length)
    .map((s) => s.text)

describe('locateQuote — re-finding a frozen quote in live Notes text', () => {
  it('finds a quote that is still there verbatim', () => {
    expect(locateQuote('we talked about the moon landing today', 'the moon landing')).toEqual({
      start: 16,
      end: 32
    })
  })

  it('returns null when the phrase has been edited away — never a nearby guess', () => {
    expect(locateQuote('we talked about the mars landing today', 'the moon landing')).toBeNull()
    expect(locateQuote('we talked about the moon LANDING today', 'the moon landing')).toBeNull()
    expect(locateQuote('', 'the moon landing')).toBeNull()
  })

  it('returns null when the phrase now appears more than once — there is no way to tell which', () => {
    expect(locateQuote('the moon landing, then the moon landing again', 'the moon landing')).toBeNull()
  })

  it('has nothing to look for when the quote is empty or missing', () => {
    expect(locateQuote('some notes', '')).toBeNull()
    expect(locateQuote('some notes', null)).toBeNull()
    expect(locateQuote(null, 'x')).toBeNull()
  })

  it('matches across the newlines a multi-line quote carries', () => {
    expect(locateQuote('intro\nthe moon landing\noutro', 'the moon landing')).toEqual({
      start: 6,
      end: 22
    })
  })
})

describe('highlightSegments — what gets drawn on the Notes text', () => {
  it('editing outside the quoted span leaves the highlight intact', () => {
    const anns = [annotation('a1', 'the moon landing')]
    const before = 'we talked about the moon landing today'
    const after = 'we talked at length about the moon landing today, and afterwards'

    expect(highlighted(before, anns)).toEqual(['the moon landing'])
    expect(highlighted(after, anns)).toEqual(['the moon landing'])
    // and it moved with the text rather than staying at the old offset
    expect(locateQuote(after, 'the moon landing').start).toBe(after.indexOf('the moon landing'))
  })

  it('editing the quoted phrase itself removes the highlight — it does not jump elsewhere', () => {
    const anns = [annotation('a1', 'the moon landing')]
    const edited = 'we talked about the mars landing today, but not the moon'

    expect(highlightSegments(edited, anns)).toEqual([{ text: edited, ids: [] }])
    expect(matchedAnnotationIds(edited, anns)).toEqual([])
  })

  it('an ambiguous quote is drawn nowhere rather than on a guessed occurrence', () => {
    const anns = [annotation('a1', 'landing')]
    expect(highlighted('landing, and landing again', anns)).toEqual([])
  })

  it('the segments always concatenate back to the exact text', () => {
    const text = 'alpha bravo charlie delta'
    const anns = [annotation('a1', 'bravo'), annotation('a2', 'delta'), annotation('a3', 'gone')]
    expect(
      highlightSegments(text, anns)
        .map((s) => s.text)
        .join('')
    ).toBe(text)
  })

  it('draws every Annotation that still matches, and only those', () => {
    const text = 'alpha bravo charlie delta'
    const anns = [annotation('a1', 'bravo'), annotation('a2', 'gone'), annotation('a3', 'delta')]
    expect(highlighted(text, anns)).toEqual(['bravo', 'delta'])
    expect(matchedAnnotationIds(text, anns)).toEqual(['a1', 'a3'])
  })

  it('overlapping Annotations become one piece carrying both ids', () => {
    const text = 'the quick brown fox'
    const anns = [annotation('a1', 'quick brown'), annotation('a2', 'brown fox')]
    expect(highlightSegments(text, anns)).toEqual([
      { text: 'the ', ids: [] },
      { text: 'quick ', ids: ['a1'] },
      { text: 'brown', ids: ['a1', 'a2'] },
      { text: ' fox', ids: ['a2'] }
    ])
  })

  it('empty Notes text draws nothing at all', () => {
    expect(highlightSegments('', [annotation('a1', 'anything')])).toEqual([])
  })

  it('no Annotations means one plain segment', () => {
    expect(highlightSegments('just notes', [])).toEqual([{ text: 'just notes', ids: [] }])
  })
})

describe('the panel is unaffected by a failed match', () => {
  it('an Annotation whose quote is gone still lists with its original frozen quote', () => {
    const anns = [annotation('a1', 'the moon landing')]
    const edited = 'we talked about the mars landing today'

    // Nothing is drawn on the text…
    expect(highlighted(edited, anns)).toEqual([])
    // …and the panel row is byte-for-byte what it always was.
    const [row] = visibleAnnotations({ 'tab-1': anns }, 'tab-1')
    expect(row.quote).toBe('the moon landing')
    expect(row).toEqual(anns[0])
  })

  it('re-matching never writes a position back onto the Annotation', () => {
    const stored = annotation('a1', 'the moon landing')
    const snapshot = JSON.stringify(stored)
    highlightSegments('we talked about the moon landing today', [stored])
    highlightSegments('nothing like it any more', [stored])
    expect(JSON.stringify(stored)).toBe(snapshot)
    expect(Object.keys(stored).sort()).toEqual(['at', 'author', 'id', 'kind', 'quote', 'tabId', 'text'])
  })
})

describe('needsQuoteRematch — the ticket-06 escape hatch', () => {
  it('is true for an ordinary tab, whose Notes text is editable', () => {
    expect(needsQuoteRematch('tab-1')).toBe(true)
  })

  it('is false for the Transcript, whose Turns are append-only and can never go stale', () => {
    expect(needsQuoteRematch(TRANSCRIPT_TAB_ID)).toBe(false)
  })
})
