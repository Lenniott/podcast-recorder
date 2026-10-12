/**
 * Client-side filter and display helpers for the Usage Dashboard per-room
 * table. Search never round-trips: it narrows the list already loaded by
 * getUsageDashboard. Enter and created-date formatting live here so later
 * row actions can share the same names without mounting the Svelte table.
 */

/** Case-insensitive substring of `name` or `slug`. An empty or whitespace
 *  query returns every room. No match returns []. Does not mutate `rooms`. */
export function filterRooms(rooms, query) {
  const needle = String(query ?? '').trim().toLowerCase()
  if (!needle) return rooms.slice()
  return rooms.filter((room) => {
    const name = String(room?.name ?? '').toLowerCase()
    const slug = String(room?.slug ?? '').toLowerCase()
    return name.includes(needle) || slug.includes(needle)
  })
}

/** Real navigation target for a room that still exists. */
export function roomEnterPath(slug) {
  return `/rec/${slug}`
}

const UTC_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Unambiguous UTC, e.g. `2 Jan 2026, 15:04 UTC`. Hours and minutes are
 *  zero-padded; the day is not. English month abbreviations only. */
export function formatRoomCreatedAt(createdAt) {
  const date = new Date(createdAt)
  const day = date.getUTCDate()
  const month = UTC_MONTHS[date.getUTCMonth()]
  const year = date.getUTCFullYear()
  const hours = String(date.getUTCHours()).padStart(2, '0')
  const minutes = String(date.getUTCMinutes()).padStart(2, '0')
  return `${day} ${month} ${year}, ${hours}:${minutes} UTC`
}
