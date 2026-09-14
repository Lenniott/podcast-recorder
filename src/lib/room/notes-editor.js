/**
 * The bits a <textarea> gave the Notes surface for free, rebuilt for the
 * `contenteditable` element that replaced it (ADR-0008 — a textarea gives
 * the browser no way to anchor a popup to an arbitrary highlighted span
 * inside it).
 *
 * Pure functions over DOM-element-shaped objects: no document/window here,
 * so the interesting decision (do we paint an inbound peer edit over this
 * browser's own live caret?) is unit-testable without a DOM.
 *
 * Used by RoomTabs.svelte. The wire protocol is unchanged — see
 * src/lib/server/ws-rooms.js's tab_text.
 */

/**
 * The plain text of the Notes surface, the `.value` equivalent.
 *
 * `innerText` is what preserves the line breaks a contenteditable stores
 * structurally (as <div>/<br> elements) — `textContent` would run every
 * line together into one. But a non-rendering host (jsdom, SSR) has no
 * `innerText` at all, and a surface the user has emptied usually still
 * holds a stray <br>, which `innerText` can report as "\n" while the
 * surface looks empty. Both are handled here so no caller has to.
 */
export function readNotesText(el) {
  if (!el) return ''
  const raw = el.textContent ?? ''
  if (raw === '') return '' // only a leftover <br>: the surface reads as empty
  const rendered = el.innerText
  return typeof rendered === 'string' ? rendered : raw
}

/** True when the browser's caret/selection currently sits inside `el`. */
export function selectionIsInside(el, selection) {
  if (!el || !selection) return false
  if (!selection.rangeCount) return false
  const node = selection.anchorNode
  if (!node) return false
  return node === el || el.contains?.(node) === true
}

/**
 * What to do when the shared model's text for the active tab differs from
 * what the Notes DOM is showing.
 *
 * A <textarea>'s `value={...}` binding only touched the DOM when the bound
 * value actually changed, so an unrelated re-render never disturbed a
 * typist. A contenteditable has no such binding — every inbound broadcast
 * would re-render and fight the local cursor — so the guard is explicit:
 *
 *  - `write`         — assign `nextText` onto the element.
 *  - `cancelUnsent`  — drop this browser's not-yet-broadcast keystrokes.
 *                      We only ever return this alongside a write: having
 *                      accepted a peer's newer text onto the screen, still
 *                      broadcasting our older text would leave the room
 *                      holding one value while our screen showed another.
 *                      Losing an unsent keystroke is recoverable; a screen
 *                      that quietly disagrees with the room is the failure
 *                      AGENTS.md's one rule is about.
 *
 * @param {object} o
 * @param {string} o.domText       what the element is showing right now
 * @param {string} o.nextText      what the shared model says it should show
 * @param {boolean} o.tabChanged   the element is being reused for a different tab
 * @param {boolean} o.hasUnsentLocalEdit  local keystrokes are still in debounce
 * @param {boolean} o.selectionInside     the local caret/selection is in the element
 */
export function planInboundNotesUpdate({
  domText,
  nextText,
  tabChanged = false,
  hasUnsentLocalEdit = false,
  selectionInside = false,
}) {
  if (domText === nextText) return { write: false, cancelUnsent: false }
  // Switching tabs: the element is being reused for entirely different
  // content, so it always takes the model's text. Any pending send belongs
  // to the tab we just left and must still go out.
  if (tabChanged) return { write: true, cancelUnsent: false }
  // Mid-keystroke: never paint over a caret that's inside the surface. The
  // local text is the write that's about to win anyway (last write wins),
  // and the next keystroke reconciles the model back to the DOM.
  if (hasUnsentLocalEdit && selectionInside) return { write: false, cancelUnsent: false }
  return { write: true, cancelUnsent: hasUnsentLocalEdit }
}
