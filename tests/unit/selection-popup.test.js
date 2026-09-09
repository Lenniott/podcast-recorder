import { describe, it, expect } from 'vitest'
import {
  POPUP_GAP,
  popupPosition,
  selectionText,
  selectionRect,
  rectOfRange
} from '../../src/lib/room/selection-popup.js'
import { createAnnotationOutbox } from '../../src/lib/room/annotation-outbox.js'

const viewport = { width: 1000, height: 800 }
const popup = { width: 200, height: 60 }

describe('popupPosition', () => {
  it('sits above the highlight, centred on it', () => {
    const { top, left, placement } = popupPosition(
      { top: 400, left: 400, width: 100, height: 20 },
      viewport,
      popup
    )
    expect(placement).toBe('above')
    expect(top).toBe(400 - popup.height - POPUP_GAP)
    expect(left).toBe(450 - popup.width / 2)
  })

  it('flips below when there is no room above', () => {
    const { top, placement } = popupPosition(
      { top: 4, left: 400, width: 100, height: 20 },
      viewport,
      popup
    )
    expect(placement).toBe('below')
    expect(top).toBe(24 + POPUP_GAP)
  })

  it('stays above (clamped) when neither side fits, rather than going off-screen', () => {
    const tall = { width: 200, height: 790 } // taller than the viewport minus its gaps
    const { top, placement } = popupPosition(
      { top: 4, left: 400, width: 100, height: 20 },
      viewport,
      tall
    )
    expect(placement).toBe('above')
    expect(top).toBeGreaterThanOrEqual(POPUP_GAP)
    expect(top + tall.height).toBeLessThanOrEqual(viewport.height)
  })

  it('clamps into the viewport at both horizontal edges', () => {
    expect(popupPosition({ top: 400, left: 0, width: 10, height: 20 }, viewport, popup).left).toBe(POPUP_GAP)
    expect(popupPosition({ top: 400, left: 995, width: 5, height: 20 }, viewport, popup).left)
      .toBe(viewport.width - popup.width - POPUP_GAP)
  })

  it('uses an explicit bottom when the rect carries one', () => {
    const { top } = popupPosition(
      { top: 4, left: 400, width: 100, height: 20, bottom: 90 },
      viewport,
      popup
    )
    expect(top).toBe(90 + POPUP_GAP)
  })
})

describe('selectionText — what becomes the frozen quote', () => {
  const fake = (text, { isCollapsed = false } = {}) => ({ isCollapsed, toString: () => text })

  it('is the browser\'s own idea of the highlighted text, ends trimmed', () => {
    expect(selectionText(fake('  moon landing \n'))).toBe('moon landing')
  })

  it('is empty for a bare caret, a whitespace-only drag, or no selection', () => {
    expect(selectionText(fake('anything', { isCollapsed: true }))).toBe('')
    expect(selectionText(fake('   '))).toBe('')
    expect(selectionText(null)).toBe('')
  })
})

describe('selectionRect / rectOfRange', () => {
  const range = (rect) => ({ getBoundingClientRect: () => rect })

  it('measures the union of a multi-line selection, not its first fragment', () => {
    const r = { top: 10, left: 20, width: 300, height: 44, bottom: 54 }
    expect(selectionRect({ rangeCount: 1, getRangeAt: () => range(r) })).toEqual(r)
  })

  it('is null for a zero-sized or missing rect', () => {
    expect(selectionRect({ rangeCount: 0 })).toBe(null)
    expect(selectionRect(null)).toBe(null)
    expect(rectOfRange(range({ top: 0, left: 0, width: 0, height: 0, bottom: 0 }))).toBe(null)
    expect(rectOfRange(null)).toBe(null)
  })

  it('rectOfRange re-measures a Range held after the live selection has gone', () => {
    // What keeps the popup anchored once the comment input steals focus.
    const held = range({ top: 100, left: 5, width: 50, height: 18, bottom: 118 })
    expect(rectOfRange(held).top).toBe(100)
  })
})

describe('annotation outbox — AGENTS.md\'s "re-announce on reconnect" rule', () => {
  it('replays creates the server never acknowledged, oldest first', () => {
    const outbox = createAnnotationOutbox()
    outbox.track({ id: 'a1', text: 'one' })
    outbox.track({ id: 'a2', text: 'two' })
    const sent = []
    outbox.resync((p) => sent.push(p.id))
    expect(sent).toEqual(['a1', 'a2'])
  })

  it('stops replaying one the server echoed back', () => {
    const outbox = createAnnotationOutbox()
    outbox.track({ id: 'a1' })
    outbox.track({ id: 'a2' })
    outbox.acknowledge('a1')
    expect(outbox.unacknowledged().map((p) => p.id)).toEqual(['a2'])
  })

  it('is a no-op when everything has landed', () => {
    const outbox = createAnnotationOutbox()
    outbox.track({ id: 'a1' })
    outbox.acknowledge('a1')
    const sent = []
    outbox.resync((p) => sent.push(p))
    expect(sent).toEqual([])
  })

  it('ignores a payload with no id (nothing could ever acknowledge it)', () => {
    const outbox = createAnnotationOutbox()
    outbox.track({ text: 'orphan' })
    expect(outbox.unacknowledged()).toEqual([])
  })
})
