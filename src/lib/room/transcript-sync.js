/**
 * Pure helpers + constants for the shared Transcript protocol. No DOM,
 * no Node built-ins — safe to import from both the server (ws-rooms.js /
 * room-state-store.js) and the browser (ResearchPanel.svelte /
 * TranscriptFacet.svelte), same split as tab-sync.js / yt-sync.js.
 *
 * The wire protocol itself lives in src/lib/server/ws-rooms.js; the storage
 * lifecycle lives in src/lib/server/room-state-store.js. See
 * docs/adr/0002-transcript-tab-append-only-shared-state.md for why the
 * Transcript can't reuse tab_text's last-write-wins mechanism.
 */

// Reserved, never-collides-with-a-real-tab id for the Transcript.
// Ordinary tabs always get a server-accepted client-generated id of the
// form 'tab-xxxxxxxx' (see RoomTabs.svelte's makeTabId()); the Transcript
// is never an entry in a room's `tabs.list` at all (see
// room-state-store.js), so any 'tab_close'/'tab_text'/'tab_switch' message
// naming this id is refused the same way any other unknown tab id is:
// there is nothing in `tabs.list` for it to find.
//
// WHAT THIS ID IS, since ticket 06 (ADR-0008): a STORAGE KEY, nothing
// more. `annotations[TRANSCRIPT_TAB_ID]` is where Turn-anchored
// Annotations are filed, under ticket 03's per-tab convention, and
// `needsQuoteRematch` uses it to tell the two anchoring surfaces apart.
//
// WHAT IT IS NOT, any more: a place. It was briefly a valid `tab_switch`
// destination — "which pill the room is looking at" was one room-shared
// value that could name either a real tab or the Transcript. ADR-0008
// retired that: the Transcript is a personal, local facet of each
// participant's own right-hand panel (see ResearchPanel.svelte), opened
// per-browser and never broadcast, because it is a reference surface you
// dip into rather than a place the whole room sits. `activeTabId` can
// therefore never hold this id, on the wire or in storage.
export const TRANSCRIPT_TAB_ID = 'transcript'

export const MAX_TRANSCRIPT_LINE_LEN = 4000
export const MAX_TRANSCRIPT_SPEAKER_LEN = 50
