/**
 * Where a Turn-anchored Annotation's frozen quote sits in the Transcript
 * (ADR-0008, ticket 06) — the Transcript-side counterpart to
 * notes-highlights.js.
 *
 * Pure string work: no DOM, no Svelte, so the one decision that matters
 * (do we draw this highlight, and on which Turn?) is unit-testable.
 *
 * ── Why this is NOT notes-highlights.js's re-match ────────────────────
 * Notes text is editable and last-write-wins, so notes-highlights.js has
 * to re-locate a quote in text that may have changed underneath it, and
 * give up honestly when it can't. A Turn is append-only and read-only once
 * it lands (ADR-0002): its text can never change, so a quote taken from a
 * Turn still points at exactly the characters it was taken from, forever.
 * `needsQuoteRematch(TRANSCRIPT_TAB_ID)` is false for precisely this
 * reason — nothing here is a stale-anchor recovery, it is just "which Turn
 * did this quote come from, and where in it".
 *
 * ── The one thing that CAN be ambiguous: which Turn ───────────────────
 * An Annotation stores `{id, tabId, kind, quote, text, author, at}` and
 * nothing else — no turnId (see room-state-store.js's addAnnotation, and
 * the stored-shape snapshot in notes-highlights.test.js). So the Turn a
 * quote came from is re-derived from the quote itself, and a short quote
 * ("the", "yeah") can genuinely occur in several Turns. Drawing it on all
 * of them, or guessing one, would put a highlight somewhere nobody
 * highlighted — the same lie notes-highlights.js refuses to tell, and the
 * same rule AGENTS.md states ("never let the UI claim things are fine when
 * they might not be").
 *
 * So the rule is deliberately strict: a quote is drawn only when it occurs
 * exactly ONCE across the whole Transcript. Anything else draws no
 * highlight at all — the Annotation still exists and still shows its
 * frozen quote in the panel, exactly as an unmatched Notes Annotation does.
 */
import { highlightSegments } from './notes-highlights.js'

/** How many times `needle` occurs in `haystack`, counting from each match's
 *  next character (so overlapping runs are counted conservatively — one
 *  more than "definitely unique" is all this needs to decide). */
export function countOccurrences(haystack, needle) {
  const text = typeof haystack === 'string' ? haystack : ''
  const quote = typeof needle === 'string' ? needle : ''
  if (!text || !quote) return 0
  let count = 0
  let at = text.indexOf(quote)
  while (at !== -1) {
    count += 1
    at = text.indexOf(quote, at + 1)
  }
  return count
}

/**
 * The id of the one Turn whose text contains `quote` exactly once and which
 * is the quote's only occurrence anywhere in the Transcript — or null when
 * the quote is missing, or occurs more than once (in one Turn or across
 * several), i.e. whenever we cannot say for certain which Turn it came from.
 */
export function locateQuoteTurn(lines, quote) {
  const needle = typeof quote === 'string' ? quote : ''
  if (!needle) return null
  let total = 0
  let turnId = null
  for (const line of lines || []) {
    const hits = countOccurrences(line?.text, needle)
    if (hits === 0) continue
    total += hits
    if (total > 1) return null // ambiguous — see the module comment
    turnId = line?.id ?? null
  }
  return total === 1 ? turnId : null
}

/**
 * Every Turn, in the order given, cut into render-ready pieces:
 *
 *   [{ id: 'turn-1', segments: [{text: 'a ', ids: []}, {text: 'quote', ids: ['ann-1']}] }, …]
 *
 * Concatenating one Turn's segment texts reproduces that Turn's text
 * exactly, so a highlight can only ever change a background — never add,
 * drop or reorder a character of what was said. Turns with no matched
 * Annotation still come back, as a single untagged segment, so the caller
 * renders one list rather than branching per Turn.
 */
export function turnHighlightSegments(lines, annotations = []) {
  const turns = Array.isArray(lines) ? lines : []
  const byTurn = new Map()
  for (const annotation of annotations || []) {
    if (!annotation?.id) continue
    const turnId = locateQuoteTurn(turns, annotation.quote)
    if (turnId == null) continue
    const list = byTurn.get(turnId) || []
    list.push(annotation)
    byTurn.set(turnId, list)
  }
  return turns.map((line) => {
    const text = typeof line?.text === 'string' ? line.text : ''
    const matched = byTurn.get(line?.id) || []
    return {
      id: line?.id,
      // highlightSegments returns [] for empty text — normalise to one
      // empty piece so the caller never has to special-case a blank Turn.
      segments: text ? highlightSegments(text, matched) : [{ text: '', ids: [] }]
    }
  })
}
