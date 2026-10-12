/**
 * Selection for the Usage Dashboard room table. Select-all is the rows
 * the current search is showing — callers pass that visible list, never
 * the unfiltered room set. These helpers do not mutate their inputs.
 */

/** Toggle membership of `slug`. Returns a new array. */
export function toggleSlug(selected, slug) {
  const has = selected.includes(slug)
  return has ? selected.filter((item) => item !== slug) : selected.concat(slug)
}

/** Slugs of the rows currently shown. Rooms left out of `visibleRooms` are not included. */
export function selectVisible(visibleRooms) {
  return visibleRooms.map((room) => room.slug)
}

export function clearSelection() {
  return []
}

/**
 * True only when every visible slug is selected and there is at least one
 * visible room. Extra selected slugs that are not visible do not matter.
 * An empty visible list is never fully covered.
 */
export function selectionCoversVisible(selected, visibleRooms) {
  if (!visibleRooms.length) return false
  const chosen = new Set(selected)
  return visibleRooms.every((room) => chosen.has(room.slug))
}
