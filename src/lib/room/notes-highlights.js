/**
 * Where an Annotation's frozen quote sits in the Notes text *right now*
 * (ADR-0008, ticket 04) — the whole anchoring mechanism, recomputed at
 * render time from the quote alone, every time, and never stored.
 *
 * Pure string work: no DOM, no Node built-ins, so the one decision that
 * matters (do we draw this highlight at all?) is unit-testable without a
 * browser. Same split as notes-editor.js / selection-popup.js.
 *
 * ── Why a re-match and not a stored position ──────────────────────────
 * Notes text is shared, editable and last-write-wins: either participant
 * can rewrite the text under an existing highlight at any moment, and no
 * peer is told which characters moved. A persisted character offset would
 * therefore be a value that is *silently* wrong the instant somebody types
 * above it — the same failure shape AGENTS.md's one rule is about ("never
 * let the UI claim things are fine when they might not be"), and exactly
 * what ADR-0008's anchoring section rejects. A highlight drawn in the
 * wrong place is strictly worse than no highlight: the Annotation's own
 * record of what was said is the frozen `quote`, and the panel keeps
 * showing that whether or not the phrase still exists in the text.
 *
 * So: nothing here is ever written back to an Annotation. The stored shape
 * stays `{ id, tabId, kind, quote, text, author, at }` — no offset, no
 * cached range, no "last known position" field (see room-state-store.js's
 * addAnnotation, which writes an Annotation once and never mutates it).
 *
 * ── Turn-anchored Annotations do NOT need any of this (ticket 06) ─────
 * This module exists solely because Notes text is *editable*. A Transcript
 * Turn is append-only and read-only once it lands (ADR-0002) — its text
 * cannot change, so an Annotation anchored to a Turn can never go stale
 * and never needs re-locating or a confidence check. Ticket 06 should draw
 * a Turn-anchored highlight straight from the stored quote and skip this
 * path entirely: `needsQuoteRematch(tabId)` below is the escape hatch, and
 * RoomTabs.svelte only ever computes segments for a real Notes tab.
 */
import { TRANSCRIPT_TAB_ID } from './transcript-sync.js'

/**
 * Does an Annotation on this tab need its quote re-located before its
 * highlight can be drawn?
 *
 * True for every ordinary tab: its Notes are a shared editable string.
 * False for the reserved Transcript tab id, whose content is Turns —
 * append-only and never edited, so a quote taken from a Turn still points
 * at exactly the text it was taken from, forever. This is the cheap gate
 * ticket 06 wants; it is deliberately keyed off the same TRANSCRIPT_TAB_ID
 * the rest of the codebase already uses to tell the two surfaces apart,
 * rather than a new field on the Annotation.
 */
export function needsQuoteRematch(tabId) {
  return tabId !== TRANSCRIPT_TAB_ID
}

/**
 * Where `quote` currently is in `text`, or null when we can't say.
 *
 * Best-effort by design (ADR-0008): an exact substring search, no fuzzy or
 * approximate matching. Either the phrase is still there verbatim or the
 * Annotation quietly loses its highlight — which is the honest outcome,
 * because "the text was edited" and "the text was edited into something
 * that only mostly matches" are the same fact to a reader.
 *
 * Returns null in three cases, all of them "we are not confident":
 *  - nothing to look for (an empty quote or empty text);
 *  - the phrase is gone (edited away or changed);
 *  - the phrase now appears more than once, so we cannot tell which
 *    occurrence this Annotation was made against. Highlighting a guess
 *    would put a highlight somewhere the person never highlighted — the
 *    exact thing this ticket forbids — and no stored position exists to
 *    break the tie (by design; see the module comment).
 */
export function locateQuote(text, quote) {
  const haystack = typeof text === 'string' ? text : ''
  const needle = typeof quote === 'string' ? quote : ''
  if (!haystack || !needle) return null
  const start = haystack.indexOf(needle)
  if (start === -1) return null // edited away
  if (haystack.indexOf(needle, start + 1) !== -1) return null // ambiguous
  return { start, end: start + needle.length }
}

/** The ids of the Annotations whose quote can currently be found, in the
 *  order given. The complement — everything else in the list — still shows
 *  in the panel with its frozen quote; it just gets no highlight. */
export function matchedAnnotationIds(text, annotations = []) {
  return (annotations || []).filter((a) => locateQuote(text, a?.quote)).map((a) => a?.id)
}

/**
 * `text` cut into consecutive pieces for rendering, each tagged with the
 * ids of the Annotations covering it:
 *
 *   [{ text: 'notes ', ids: [] }, { text: 'quoted bit', ids: ['ann-1'] }, …]
 *
 * Concatenating every `text` reproduces the input exactly — the caller
 * paints a mirror of the Notes text and only changes the *background* of
 * the tagged pieces, so a highlight can never add, drop or reorder a
 * character of what the person is editing.
 *
 * Overlapping Annotations are handled by splitting at every boundary, so
 * an overlap renders as one piece carrying both ids rather than as two
 * highlights fighting over the same characters.
 */
export function highlightSegments(text, annotations = []) {
  const source = typeof text === 'string' ? text : ''
  if (!source) return []

  const hits = []
  for (const annotation of annotations || []) {
    const at = locateQuote(source, annotation?.quote)
    if (at) hits.push({ id: annotation.id, start: at.start, end: at.end })
  }
  if (hits.length === 0) return [{ text: source, ids: [] }]

  const bounds = new Set([0, source.length])
  for (const hit of hits) {
    bounds.add(hit.start)
    bounds.add(hit.end)
  }
  const points = [...bounds].sort((a, b) => a - b)

  const segments = []
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i]
    const end = points[i + 1]
    if (end <= start) continue
    const ids = hits.filter((h) => h.start <= start && h.end >= end).map((h) => h.id)
    const previous = segments[segments.length - 1]
    if (previous && sameIds(previous.ids, ids)) previous.text += source.slice(start, end)
    else segments.push({ text: source.slice(start, end), ids })
  }
  return segments
}

function sameIds(a, b) {
  return a.length === b.length && a.every((id, i) => id === b[i])
}
