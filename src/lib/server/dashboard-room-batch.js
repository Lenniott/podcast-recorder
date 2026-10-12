/**
 * Bulk unlock and bulk delete for the Usage Dashboard.
 *
 * Unknown slugs are skipped and do not abort the rest of the set. Unlock
 * goes through `unlockRoom` (guest-lock clock and inactivity only). Delete
 * goes through `deleteDashboardRoom` (same room removal as one row,
 * including leaving research usage totals in place).
 */
import { unlockRoom } from './guest-join.js'
import { deleteDashboardRoom } from './dashboard-room-delete.js'

/**
 * Unlock each string slug. A slug `unlockRoom` does not accept (unknown,
 * empty, or not a string) is skipped. One skip does not stop the rest.
 *
 * @returns {{ unlocked: string[], skipped: string[] }}
 */
export function unlockRooms(slugs, now = Date.now()) {
  const unlocked = []
  const skipped = []
  for (const slug of slugs) {
    if (typeof slug !== 'string') {
      skipped.push(slug)
      continue
    }
    const result = unlockRoom(slug, now)
    if (result.ok) unlocked.push(slug)
    else skipped.push(slug)
  }
  return { unlocked, skipped }
}

/**
 * Delete each slug when the site password is satisfied. `siteAuthed`
 * anything other than `true` deletes nothing. Otherwise each slug is
 * handed to `deleteDashboardRoom`; unknown slugs and other 404s go to
 * `skipped`, and a bad slug does not stop the rest.
 *
 * @returns {{ ok: true, status: 200, deleted: string[], skipped: string[] }
 *   | { ok: false, status: 403, deleted: [], skipped: string[] }}
 */
export function deleteRooms({ slugs, siteAuthed } = {}) {
  if (siteAuthed !== true) {
    return { ok: false, status: 403, deleted: [], skipped: slugs }
  }
  const deleted = []
  const skipped = []
  for (const slug of slugs) {
    const result = deleteDashboardRoom({ slug, siteAuthed: true })
    if (result.ok) deleted.push(slug)
    else skipped.push(slug)
  }
  return { ok: true, status: 200, deleted, skipped }
}
