/**
 * Pure helpers + constants for the shared Transcript Tab protocol. No DOM,
 * no Node built-ins — safe to import from both the server (ws-rooms.js /
 * room-state-store.js) and the browser (RoomTabs.svelte / TranscriptTab.svelte),
 * same split as tab-sync.js / yt-sync.js.
 *
 * The wire protocol itself lives in src/lib/server/ws-rooms.js; the storage
 * lifecycle lives in src/lib/server/room-state-store.js. See
 * docs/adr/0002-transcript-tab-append-only-shared-state.md for why the
 * Transcript can't reuse tab_text's last-write-wins mechanism.
 */

// Reserved, never-collides-with-a-real-tab id for the one permanent
// Transcript tab. Ordinary tabs always get a server-accepted client-
// generated id of the form 'tab-xxxxxxxx' (see RoomTabs.svelte's
// makeTabId()) — this constant is used only client-side (to key/highlight
// the pinned Transcript tab-strip entry) since the Transcript is never an
// entry in a room's `tabs.list` at all (see room-state-store.js). Because
// of that, any hand-crafted 'tab_close'/'tab_text' WS message that names
// this id is refused by room-state-store.js the same way any other unknown
// tab id is: there is nothing in `tabs.list` for it to find.
export const TRANSCRIPT_TAB_ID = 'transcript'

export const MAX_TRANSCRIPT_LINE_LEN = 4000
export const MAX_TRANSCRIPT_SPEAKER_LEN = 50
