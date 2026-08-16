/**
 * Pure helpers + constants for the shared tab protocol. No DOM, no Node
 * built-ins — safe to import from both the server (ws-rooms.js) and the
 * browser (RoomTabs.svelte), same split as yt-sync.js.
 *
 * The wire protocol itself lives in src/lib/server/ws-rooms.js.
 */

export const MAX_TABS = 8
export const MAX_TAB_TEXT_LEN = 20000

/**
 * Picks the lowest-numbered "Tab N" not already in use, so closing a
 * middle tab and opening a new one reuses the gap instead of always
 * counting up.
 */
export function nextTabTitle(existingTitles = []) {
  const used = new Set(existingTitles)
  for (let n = 1; ; n++) {
    const title = `Tab ${n}`
    if (!used.has(title)) return title
  }
}
