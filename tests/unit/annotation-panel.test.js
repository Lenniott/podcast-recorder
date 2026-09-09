import { describe, it, expect } from 'vitest'
import {
  applyAnnotationEntry,
  applyAnnotationState,
  applyAnnotationError,
  annotationStatus,
  isCardAnnotation,
  visibleAnnotations
} from '../../src/lib/research/annotation-panel.js'
import {
  ANNOTATION_KINDS,
  MAX_ANNOTATION_QUOTE_LEN,
  isAiAuthoredKind,
  makeAnnotationId,
  normalizeQuote,
  upsertAnnotation
} from '../../src/lib/research/annotation-sync.js'

const entry = (id, over = {}) => ({
  id,
  tabId: 'tab-1',
  kind: 'comment',
  quote: 'a quote',
  text: 'a note',
  author: 'Host',
  at: 1000,
  ...over
})

describe('annotation-sync', () => {
  it("'comment' (human) and 'card' (a Custom Prompt's answer) are both known kinds", () => {
    expect(ANNOTATION_KINDS).toContain('comment')
    expect(ANNOTATION_KINDS).toContain('card')
  })

  it('only a Card is AI-authored — that is what Guest Research Access is applied to', () => {
    expect(isAiAuthoredKind('card')).toBe(true)
    expect(isAiAuthoredKind('comment')).toBe(false)
    expect(isAiAuthoredKind(undefined)).toBe(false)
  })

  it('makeAnnotationId is unique and prefixed', () => {
    const ids = new Set(Array.from({ length: 200 }, makeAnnotationId))
    expect(ids.size).toBe(200)
    expect([...ids].every((id) => id.startsWith('ann-'))).toBe(true)
  })

  it('normalizeQuote trims the ends, bounds the length, and leaves the interior exact', () => {
    expect(normalizeQuote('  hello  world  ')).toBe('hello  world')
    expect(normalizeQuote('a\nb\tc')).toBe('a\nb\tc')
    expect(normalizeQuote('x'.repeat(MAX_ANNOTATION_QUOTE_LEN + 50))).toHaveLength(MAX_ANNOTATION_QUOTE_LEN)
    expect(normalizeQuote(null)).toBe('')
  })

  it('upsertAnnotation appends a new id and replaces an existing one in place', () => {
    const list = [entry('a1'), entry('a2')]
    expect(upsertAnnotation(list, entry('a3')).map((e) => e.id)).toEqual(['a1', 'a2', 'a3'])
    const replaced = upsertAnnotation(list, entry('a2', { text: 'edited' }))
    expect(replaced).toHaveLength(2)
    expect(replaced[1].text).toBe('edited')
    expect(list[1].text).toBe('a note') // input untouched
  })
})

describe('annotation-panel — applying broadcasts', () => {
  it('applyAnnotationEntry files an Annotation under its own tab', () => {
    const next = applyAnnotationEntry({}, { tabId: 'tab-1', entry: entry('a1') })
    expect(next['tab-1']).toHaveLength(1)
    expect(applyAnnotationEntry(next, { tabId: 'tab-2', entry: entry('a2', { tabId: 'tab-2' }) })['tab-1']).toHaveLength(1)
  })

  it('applyAnnotationEntry upserts, so a re-sent create never shows as two Comments', () => {
    const first = applyAnnotationEntry({}, { tabId: 'tab-1', entry: entry('a1') })
    const again = applyAnnotationEntry(first, { tabId: 'tab-1', entry: entry('a1') })
    expect(again['tab-1']).toHaveLength(1)
  })

  it('applyAnnotationState replaces one tab\'s list with the server\'s', () => {
    const before = applyAnnotationEntry({}, { tabId: 'tab-1', entry: entry('stale') })
    const after = applyAnnotationState(before, { tabId: 'tab-1', entries: [entry('a1'), entry('a2')] })
    expect(after['tab-1'].map((e) => e.id)).toEqual(['a1', 'a2'])
  })

  it('applyAnnotationState leaves other tabs alone', () => {
    const before = applyAnnotationEntry({}, { tabId: 'tab-2', entry: entry('keep', { tabId: 'tab-2' }) })
    const after = applyAnnotationState(before, { tabId: 'tab-1', entries: [entry('a1')] })
    expect(after['tab-2'].map((e) => e.id)).toEqual(['keep'])
  })

  it('applyAnnotationError replaces a pending Card with the errored one, in place', () => {
    const pending = entry('k1', { kind: 'card', status: 'pending', text: '' })
    const before = applyAnnotationEntry({}, { tabId: 'tab-1', entry: pending })
    const after = applyAnnotationError(before, {
      tabId: 'tab-1',
      id: 'k1',
      message: 'The Research Assistant timed out.',
      entry: { ...pending, status: 'errored', error: 'The Research Assistant timed out.' }
    })
    expect(after['tab-1']).toHaveLength(1)
    expect(after['tab-1'][0]).toMatchObject({ status: 'errored', error: 'The Research Assistant timed out.' })
  })

  it('applyAnnotationError with no entry leaves the list untouched rather than dropping a row', () => {
    const before = applyAnnotationEntry({}, { tabId: 'tab-1', entry: entry('a1') })
    expect(applyAnnotationError(before, { tabId: 'tab-1', id: 'a1' })).toBe(before)
  })
})

describe('annotation-panel — telling a Card apart from a Comment', () => {
  it('isCardAnnotation is what the panel badges as AI-authored', () => {
    expect(isCardAnnotation(entry('k1', { kind: 'card' }))).toBe(true)
    expect(isCardAnnotation(entry('a1'))).toBe(false)
    expect(isCardAnnotation(null)).toBe(false)
  })

  it('annotationStatus defaults to answered — a Comment, and any row stored before Cards existed', () => {
    expect(annotationStatus(entry('a1'))).toBe('answered')
    expect(annotationStatus({})).toBe('answered')
    expect(annotationStatus(entry('k1', { kind: 'card', status: 'pending' }))).toBe('pending')
    expect(annotationStatus(entry('k2', { kind: 'card', status: 'errored' }))).toBe('errored')
  })
})

describe('annotation-panel — visibleAnnotations', () => {
  it('shows only the active tab\'s Annotations', () => {
    const byTab = {
      'tab-1': [entry('a1')],
      'tab-2': [entry('b1', { tabId: 'tab-2' })]
    }
    expect(visibleAnnotations(byTab, 'tab-1').map((e) => e.id)).toEqual(['a1'])
    expect(visibleAnnotations(byTab, 'tab-2').map((e) => e.id)).toEqual(['b1'])
    expect(visibleAnnotations(byTab, 'tab-nope')).toEqual([])
    expect(visibleAnnotations(undefined, 'tab-1')).toEqual([])
  })

  it('is newest first, with the later arrival winning a tie', () => {
    const byTab = {
      'tab-1': [entry('older', { at: 1 }), entry('tieA', { at: 5 }), entry('tieB', { at: 5 }), entry('newest', { at: 9 })]
    }
    expect(visibleAnnotations(byTab, 'tab-1').map((e) => e.id)).toEqual(['newest', 'tieB', 'tieA', 'older'])
  })

  it('keeps every kind in the one list (ticket 05\'s Cards will interleave by time)', () => {
    const byTab = {
      'tab-1': [entry('c1', { kind: 'comment', at: 1 }), entry('k1', { kind: 'card', at: 2 })]
    }
    expect(visibleAnnotations(byTab, 'tab-1').map((e) => e.kind)).toEqual(['card', 'comment'])
  })
})
