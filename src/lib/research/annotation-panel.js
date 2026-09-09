/**
 * Pure state-transition logic for the Annotation list in the right-side
 * panel (ADR-0008, ticket 03) — kept out of ResearchPanel.svelte for the
 * same reason research-panel.js is: vitest.config.js excludes .svelte files
 * from coverage entirely, so the decisions live in a plain module and the
 * component just calls it.
 *
 * ResearchPanel.svelte's `annotationsByTab` is fed exclusively by
 * applyAnnotationEntry/applyAnnotationState below, driven by the room's
 * `annotation_entry`/`annotation_state` broadcasts (see ws-rooms.js) —
 * never by copying another component's local variable. Same discipline as
 * research-panel.js's own entriesByTab.
 */
import { upsertAnnotation } from './annotation-sync.js'
import { TRANSCRIPT_TAB_ID } from '../room/transcript-sync.js'

/** Applies an `annotation_entry` broadcast into annotationsByTab. Upsert,
 *  not append: a reconnecting peer may re-send a create it never saw
 *  acknowledged, and the server answers that with the already-stored entry
 *  (see room-state-store.js's addAnnotation) — landing it twice in the list
 *  would show one Comment as two. */
export function applyAnnotationEntry(annotationsByTab, msg) {
  return { ...annotationsByTab, [msg.tabId]: upsertAnnotation(annotationsByTab[msg.tabId], msg.entry) }
}

/** Applies an `annotation_state` replay (one tab's full list) — the
 *  server's list wins outright, exactly as applyResearchState does. */
export function applyAnnotationState(annotationsByTab, msg) {
  return { ...annotationsByTab, [msg.tabId]: msg.entries }
}

/** Applies an `annotation_error` broadcast — a Card whose Research
 *  Assistant lookup failed (ADR-0008, ticket 05). The message carries the
 *  errored Annotation itself, so this is the same upsert
 *  applyAnnotationEntry does rather than a second way to mutate the list;
 *  it exists so a caller can route the error message type without knowing
 *  that. A pending Card must always end up somewhere visible. */
export function applyAnnotationError(annotationsByTab, msg) {
  if (!msg?.entry) return annotationsByTab
  return applyAnnotationEntry(annotationsByTab, msg)
}

/** Whether an Annotation's body came from the Research Assistant rather
 *  than from a person — what the panel labels and styles differently. */
export function isCardAnnotation(annotation) {
  return annotation?.kind === 'card'
}

/**
 * An Annotation's lifecycle status, defaulted for the rows that predate it.
 *
 * A Comment has always been complete on arrival, and Annotations stored
 * before Cards existed carry no `status` at all — both are 'answered'.
 * Only a Card is ever 'pending' or 'errored'.
 */
export function annotationStatus(annotation) {
  return annotation?.status || 'answered'
}

/**
 * Which Annotations the panel shows: the active tab's, newest first.
 *
 * Per-tab, never a merged room-wide list — an Annotation quotes text that
 * only exists in one tab's Notes, so showing it under another tab would
 * quote something that isn't there. Newest first matches the Card ordering
 * CONTEXT.md already specifies for the panel ("newest Cards sit at the
 * top"), so the two kinds will interleave sensibly when ticket 05 adds
 * 'card' rather than needing a second ordering rule.
 */
export function visibleAnnotations(annotationsByTab, activeTabId) {
  return newestFirst((annotationsByTab || {})[activeTabId] || [])
}

/**
 * Which Annotations the panel's feed shows now that the Transcript is a
 * facet rather than a Tab (ADR-0008, ticket 06): the active Notes tab's
 * Annotations AND every Turn-anchored one, in one newest-first list.
 *
 * This is the merge CONTEXT.md's **Annotation** entry describes — "listed
 * together with every other Annotation in the panel regardless of which
 * kind authored it or which surface (Notes or Transcript) it's anchored
 * to" — and it is only correct because of what the two surfaces are.
 * `visibleAnnotations` above stays per-tab because a Notes Annotation
 * quotes text that exists in exactly one tab, so showing it under another
 * would quote something that isn't there. A Turn-anchored Annotation
 * quotes the Transcript, which is one room-wide surface that no tab owns
 * and that the participant can open in this very panel — it is never "not
 * there", whichever Notes tab happens to be active.
 *
 * The reserved Transcript id is still the storage key it always was
 * (ticket 03's per-tab convention); what changed in ticket 06 is only that
 * it stopped being something `activeTabId` can ever hold.
 */
export function visibleAnnotationsForRoom(annotationsByTab, activeTabId) {
  const byTab = annotationsByTab || {}
  const notes = activeTabId && activeTabId !== TRANSCRIPT_TAB_ID ? byTab[activeTabId] || [] : []
  const turns = byTab[TRANSCRIPT_TAB_ID] || []
  return newestFirst([...notes, ...turns])
}

/** Newest first, ties broken by the order the list already had — so two
 *  Annotations written in the same millisecond keep a stable, repeatable
 *  order instead of flickering between renders. */
function newestFirst(list) {
  return list
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (b.entry.at || 0) - (a.entry.at || 0) || b.index - a.index)
    .map(({ entry }) => entry)
}
