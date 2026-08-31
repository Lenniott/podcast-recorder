/**
 * Pure helpers + constants for the shared Research Assistant panel protocol
 * (ticket 04). No DOM, no Node built-ins — safe to import from both the
 * server (ws-rooms.js / room-state-store.js) and the browser
 * (ResearchPanel.svelte / research-panel.js), same split as
 * tab-sync.js / transcript-sync.js.
 *
 * The wire protocol itself lives in src/lib/server/ws-rooms.js; the storage
 * lifecycle lives in src/lib/server/room-state-store.js. See
 * docs/adr/0002-transcript-tab-append-only-shared-state.md's note that
 * Research Assistant results are shared the same way as the Transcript
 * (broadcast, scoped per Tab, kept in server memory alongside the rest of a
 * room's Tab state).
 */

// Matches the research endpoint's own MAX_QUERY_LENGTH
// (src/routes/rec/[slug]/research/+server.js) — a manual ask can never be
// longer than what the endpoint itself would accept.
export const MAX_RESEARCH_QUESTION_LEN = 500

// Generous but bounded — an answer is trusted-enough client-relayed content
// (see room-state-store.js's resolveResearchEntry), same trust model as
// tab_text; this cap exists only to stop an unbounded value, not to
// second-guess a legitimate long answer.
export const MAX_RESEARCH_ANSWER_LEN = 8000

export const MAX_RESEARCH_CITATIONS = 10
export const MAX_RESEARCH_CITATION_TEXT_LEN = 300

/**
 * Normalizes whatever citations array a client relays alongside an answer
 * into a small, bounded, display-safe shape — never trusting length or
 * field types from the wire. Citations ticket 02's endpoint returns must
 * stay visible (not discarded), so this only bounds them, never drops a
 * citation for having "just" a url and no title.
 */
export function sanitizeCitations(citations) {
  if (!Array.isArray(citations)) return []
  return citations
    .filter((c) => c && typeof c.url === 'string' && c.url.trim())
    .slice(0, MAX_RESEARCH_CITATIONS)
    .map((c) => ({
      url: c.url.trim().slice(0, MAX_RESEARCH_CITATION_TEXT_LEN),
      title: typeof c.title === 'string' ? c.title.trim().slice(0, MAX_RESEARCH_CITATION_TEXT_LEN) : ''
    }))
}

/** Client-generated id (like RoomTabs.svelte's makeTabId()) — lets the
 *  asking browser correlate its own later research_resolve/research_error
 *  message with the entry it just asked to create, without waiting for a
 *  round trip to learn a server-assigned id first. */
export function makeResearchEntryId() {
  return 'research-' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6)
}

/** Upserts one entry into a tab's entry list by id — used identically by
 *  the server (room-state-store.js, indirectly) and the client
 *  (research-panel.js) so "how a create/update lands in the per-tab list"
 *  is defined exactly once. */
export function upsertResearchEntry(entries, entry) {
  const list = entries || []
  const idx = list.findIndex((e) => e.id === entry.id)
  if (idx === -1) return [...list, entry]
  const next = list.slice()
  next[idx] = entry
  return next
}
