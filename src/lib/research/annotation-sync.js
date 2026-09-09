/**
 * Pure helpers + constants for the shared **Annotation** protocol
 * (ADR-0008, ticket 03). No DOM, no Node built-ins — safe to import from
 * both the server (ws-rooms.js / room-state-store.js) and the browser
 * (ResearchPanel.svelte / annotation-panel.js / RoomTabs.svelte), exactly
 * the split research-sync.js already uses for research entries.
 *
 * The wire protocol itself lives in src/lib/server/ws-rooms.js; the storage
 * lifecycle lives in src/lib/server/room-state-store.js. Deliberately a
 * sibling of research-sync.js rather than an addition to it: an Annotation
 * is its own content kind (see CONTEXT.md's **Annotation**), stored in its
 * own per-tab collection, and nothing about a research entry's
 * pending/answered/errored lifecycle applies to it.
 */

/**
 * The `kind` discriminator — which sort of author produced an Annotation
 * (see CONTEXT.md's **Comment** and **Card**).
 *
 *   'comment' — a person typed it (ticket 03).
 *   'card'    — a Custom Prompt produced it (ticket 05).
 *
 * The panel lists every kind together, so this exists to label a row and to
 * let the panel render one kind differently — never to scope storage,
 * broadcast, or replay, all of which are kind-agnostic on purpose.
 */
export const ANNOTATION_KINDS = ['comment', 'card']

/**
 * Whether a `kind` needs the Research Assistant to produce its body.
 *
 * This is the single place "which Annotation kinds cost an AI call" is
 * decided, and it is what Guest Research Access is applied to (see
 * ws-rooms.js's annotation_ask handler). A Comment is a plain human note
 * and is deliberately ungated (ticket 03); a Card is an AI lookup and is
 * gated exactly like Ask (ADR-0008).
 */
export function isAiAuthoredKind(kind) {
  return kind === 'card'
}

/**
 * An Annotation's lifecycle status.
 *
 * A Comment has none of this — it is complete the instant a person submits
 * it — so it is stored as 'answered' from birth and nothing ever moves it.
 * A Card genuinely does have a lifecycle, because its body is not known
 * until the Research Assistant replies: it is created 'pending', broadcast
 * immediately so every peer sees the lookup happening, and then moves once
 * to 'answered' or 'errored'. A pending Card must NEVER be left stuck with
 * no explanation — that is the same "never let the UI claim things are
 * fine" rule AGENTS.md states for recording health, and is why the error
 * path stores a visible reason rather than silently dropping the row.
 */
export const ANNOTATION_STATUSES = ['pending', 'answered', 'errored']

/** Same cap, and same reasoning, as MAX_RESEARCH_ANSWER_LEN: a Card body is
 *  freeform Research Assistant output, not a typed note, so it gets the
 *  answer budget rather than the Comment one. */
export const MAX_ANNOTATION_ANSWER_LEN = 8000

/** Capped for the same reason MAX_RESEARCH_ANSWER_LEN is: a frozen quote is
 *  trusted-enough client-relayed content, and this only stops an unbounded
 *  value rather than second-guessing a legitimately long excerpt. */
export const MAX_ANNOTATION_QUOTE_LEN = 2000

/** A Comment is a short note typed during a show, not an essay. Generous
 *  enough that nobody hits it mid-thought; bounded so nobody can post a
 *  megabyte into every peer's panel. */
export const MAX_ANNOTATION_TEXT_LEN = 2000

/** Matches the 50-char cap ws-rooms.js already applies to a join name,
 *  which is where an author name comes from. */
export const MAX_ANNOTATION_AUTHOR_LEN = 50

/** Client-generated id (like makeResearchEntryId / RoomTabs' makeTabId) so
 *  the creating browser can recognise the server's echo of its own
 *  Annotation without waiting for a round trip to learn an id first — which
 *  is what lets the outbox in $lib/room/annotation-outbox.js tell "the
 *  server has this" from "this never made it off my machine". */
export function makeAnnotationId() {
  return 'ann-' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6)
}

/** Upserts one Annotation into a tab's list by id — used identically by the
 *  server (room-state-store.js) and the client (annotation-panel.js) so
 *  "how a create lands in the per-tab list" is defined exactly once.
 *  Upsert rather than push because a reconnecting client may legitimately
 *  re-send an annotation_create it never saw acknowledged (see
 *  annotation-outbox.js) — replaying it must not create a duplicate. */
export function upsertAnnotation(entries, entry) {
  const list = entries || []
  const idx = list.findIndex((e) => e.id === entry.id)
  if (idx === -1) return [...list, entry]
  const next = list.slice()
  next[idx] = entry
  return next
}

/**
 * Normalizes a highlighted excerpt into the value that becomes an
 * Annotation's permanent `quote`.
 *
 * Only the ends are trimmed and the length bounded — the interior is left
 * byte-for-byte as the person highlighted it. This is the whole point of a
 * frozen quote (CONTEXT.md's **Annotation**): it is the Annotation's
 * permanent record of what was said, never recomputed from current Notes
 * text and never replaced. Ticket 04 re-finds this string in the live Notes
 * to *draw* a highlight; that lookup failing changes nothing here.
 */
export function normalizeQuote(quote) {
  return String(quote ?? '').trim().slice(0, MAX_ANNOTATION_QUOTE_LEN)
}
