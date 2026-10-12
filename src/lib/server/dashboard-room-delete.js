import { deleteRoom, getRoomBySlug } from './db.js'

/**
 * Complete delete of one dashboard room.
 *
 * The home-page `delete_room` action should only read `slug` from the form
 * and whether the site password is satisfied, then:
 *
 *   const result = deleteDashboardRoom({ slug, siteAuthed })
 *   if (!result.ok) return fail(result.status)
 *   throw redirect(303, '/')
 *
 * This calls `deleteRoom` (metadata, durable content, server copies). It
 * does not touch `research_usage` — those totals outlive the room.
 */
export function deleteDashboardRoom({ slug, siteAuthed } = {}) {
  if (siteAuthed !== true) return { ok: false, status: 403 }
  if (typeof slug !== 'string' || slug.length === 0) return { ok: false, status: 404 }
  if (!getRoomBySlug(slug)) return { ok: false, status: 404 }
  deleteRoom(slug)
  return { ok: true, status: 200 }
}
