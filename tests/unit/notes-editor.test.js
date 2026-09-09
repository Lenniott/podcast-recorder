import { describe, it, expect } from 'vitest'
import {
  readNotesText,
  selectionIsInside,
  planInboundNotesUpdate
} from '../../src/lib/room/notes-editor.js'

// Minimal DOM-element stand-ins. The real element is a contenteditable
// <div>; only textContent/innerText/contains are ever touched.
const el = ({ textContent = '', innerText, children = [] } = {}) => ({
  textContent,
  ...(innerText === undefined ? {} : { innerText }),
  contains: (node) => children.includes(node)
})

describe('readNotesText', () => {
  it('prefers innerText, which keeps the line breaks contenteditable stores as elements', () => {
    // textContent runs the lines together; innerText is the one that's right.
    expect(readNotesText(el({ textContent: 'line oneline two', innerText: 'line one\nline two' })))
      .toBe('line one\nline two')
  })

  it('falls back to textContent on a host with no innerText (jsdom, SSR)', () => {
    expect(readNotesText(el({ textContent: 'plain notes' }))).toBe('plain notes')
  })

  it('reads as empty when only a leftover <br> remains, whatever innerText says', () => {
    // Emptying a contenteditable usually leaves a stray <br> behind, which
    // innerText reports as a newline while the surface looks blank.
    expect(readNotesText(el({ textContent: '', innerText: '\n' }))).toBe('')
  })

  it('is empty for no element at all', () => {
    expect(readNotesText(null)).toBe('')
  })
})

describe('selectionIsInside', () => {
  const node = { nodeType: 3 }
  const element = el({ children: [node] })

  it('is true when the caret sits on a node inside the surface', () => {
    expect(selectionIsInside(element, { rangeCount: 1, anchorNode: node })).toBe(true)
  })

  it('is true when the selection anchors on the surface itself', () => {
    expect(selectionIsInside(element, { rangeCount: 1, anchorNode: element })).toBe(true)
  })

  it('is false for a selection somewhere else on the page', () => {
    expect(selectionIsInside(element, { rangeCount: 1, anchorNode: { nodeType: 3 } })).toBe(false)
  })

  it.each([
    ['no selection object', null],
    ['no range', { rangeCount: 0, anchorNode: node }],
    ['no anchor node', { rangeCount: 1, anchorNode: null }]
  ])('is false with %s', (_label, selection) => {
    expect(selectionIsInside(element, selection)).toBe(false)
  })

  it('is false with no element', () => {
    expect(selectionIsInside(null, { rangeCount: 1, anchorNode: node })).toBe(false)
  })
})

describe('planInboundNotesUpdate', () => {
  const plan = (o) => planInboundNotesUpdate({ domText: '', nextText: '', ...o })

  it('does nothing when the surface already shows the text', () => {
    expect(plan({ domText: 'same', nextText: 'same' })).toEqual({ write: false, cancelUnsent: false })
  })

  it("writes a peer's edit in when nobody is typing here", () => {
    expect(plan({ domText: 'old', nextText: 'peer text' }))
      .toEqual({ write: true, cancelUnsent: false })
  })

  it('leaves the surface alone while the caret is in it and keystrokes are unsent', () => {
    // The whole point of the guard: an unrelated peer's broadcast must not
    // paint over this browser's own in-progress typing or move its cursor.
    expect(plan({
      domText: 'what I am typing',
      nextText: 'what my co-host just sent',
      hasUnsentLocalEdit: true,
      selectionInside: true
    })).toEqual({ write: false, cancelUnsent: false })
  })

  it('still writes when the caret is elsewhere, even with unsent keystrokes — and drops them', () => {
    // Having put the peer's newer text on screen, broadcasting our older
    // text would leave the room holding one value and this screen another.
    expect(plan({
      domText: 'my half-typed line',
      nextText: 'peer text',
      hasUnsentLocalEdit: true,
      selectionInside: false
    })).toEqual({ write: true, cancelUnsent: true })
  })

  it('writes when the caret is inside but nothing local is pending', () => {
    expect(plan({ domText: 'old', nextText: 'peer text', selectionInside: true }))
      .toEqual({ write: true, cancelUnsent: false })
  })

  it('always takes the model on a tab switch, and keeps the old tab\'s pending send', () => {
    expect(plan({
      domText: "tab A's text",
      nextText: "tab B's text",
      tabChanged: true,
      hasUnsentLocalEdit: true,
      selectionInside: true
    })).toEqual({ write: true, cancelUnsent: false })
  })

  it('skips a no-op write even on a tab switch', () => {
    expect(plan({ domText: 'identical', nextText: 'identical', tabChanged: true }))
      .toEqual({ write: false, cancelUnsent: false })
  })
})
