/**
 * Pure geometry + selection helpers behind SelectionPopup.svelte (ADR-0008,
 * ticket 03). No document/window here — the component reads the live
 * Selection and viewport and hands the plain numbers in, so the actual
 * decision (where does the popup go so it stays on screen?) is unit-testable
 * without a DOM. Same split as notes-editor.js.
 */

/** Gap between the highlighted text and the popup, and the minimum breathing
 *  room kept against each viewport edge. */
export const POPUP_GAP = 8

/**
 * Where to put a popup of `popupWidth` x `popupHeight` relative to the
 * highlighted span's viewport rect.
 *
 * Preference is above the selection (a popup below would cover the next line
 * of text the person is reading and, on a long selection, the caret itself);
 * it flips below only when there genuinely isn't room above. Horizontally it
 * centres on the selection, then is clamped into the viewport — never
 * allowed to hang off an edge where its buttons can't be clicked.
 *
 * Returns viewport coordinates, for a `position: fixed` element.
 *
 * @param {{top:number,left:number,width:number,height:number,bottom?:number}} rect
 * @param {{width:number,height:number}} viewport
 * @param {{width:number,height:number}} popup
 */
export function popupPosition(rect, viewport, popup, gap = POPUP_GAP) {
  const bottom = typeof rect.bottom === 'number' ? rect.bottom : rect.top + rect.height
  const centre = rect.left + rect.width / 2
  const maxLeft = Math.max(gap, viewport.width - popup.width - gap)
  const left = Math.min(Math.max(gap, centre - popup.width / 2), maxLeft)

  const above = rect.top - popup.height - gap
  const below = bottom + gap
  // Below only when above would push the popup off the top of the screen AND
  // below actually fits; otherwise stay above and clamp, so a popup is never
  // parked somewhere it can't be fully seen.
  const preferBelow = above < gap && below + popup.height + gap <= viewport.height
  const top = preferBelow
    ? below
    : Math.min(Math.max(gap, above), Math.max(gap, viewport.height - popup.height - gap))

  return { top, left, placement: preferBelow ? 'below' : 'above' }
}

/**
 * The text of a selection, as the popup would freeze it into a quote —
 * or '' when there is nothing usefully selected (a bare caret, whitespace
 * only, or no selection at all). Callers treat '' as "don't show the popup".
 *
 * Deliberately reads `selection.toString()` rather than reconstructing text
 * from nodes: that is what the browser considers highlighted, which is what
 * the person actually saw highlighted.
 */
export function selectionText(selection) {
  if (!selection || selection.isCollapsed) return ''
  return String(selection.toString() || '').trim()
}

/**
 * The viewport rect of the highlighted span, or null when there isn't one.
 *
 * A selection spanning several lines has several client rects; the union
 * (getBoundingClientRect) is used on purpose so the popup anchors to the
 * whole highlight rather than jumping to whichever fragment happens to be
 * first.
 */
export function selectionRect(selection) {
  if (!selection || !selection.rangeCount) return null
  return rectOfRange(selection.getRangeAt(0))
}

/**
 * The same measurement for a Range held on its own, after the live
 * selection has moved on.
 *
 * This is what keeps the popup anchored once the Comment composer opens:
 * clicking into the input collapses the document's selection, so the caller
 * clones the Range at that moment and re-measures it from here whenever the
 * page scrolls or resizes. Measuring the Range is not the same as
 * remembering the quote — the quote is frozen text (see normalizeQuote in
 * annotation-sync.js) and never re-derived from geometry.
 */
export function rectOfRange(range) {
  const rect = range?.getBoundingClientRect?.()
  if (!rect) return null
  if (!rect.width && !rect.height) return null
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height, bottom: rect.bottom }
}
