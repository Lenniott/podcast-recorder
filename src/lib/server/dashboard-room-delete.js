import { deleteRoom, getRoomBySlug } from './db.js'

/**
 * Complete delete of one dashboard room.
 *
 * The home-page action is the site-password gate. This function does not
 * check it. Call it only after that gate has passed:
 *
 *   const denied = requireSiteAuth(cookies)
 *   if (denied) return denied
 *   const result = deleteDashboardRoom(slug)
 *   if (!result.ok) return fail(result.status)
 *   throw redirect(303, '/')
 *
 * Unknown, empty, and non-string slugs return 404 and do not throw.
 * `deleteRoom` removes metadata, durable content, and server copies.
 * `research_usage` is left alone — those totals outlive the room.
 */
export function deleteDashboardRoom(slug) {
  if (typeof slug !== 'string' || slug.length === 0) return { ok: false, status: 404 }
  if (!getRoomBySlug(slug)) return { ok: false, status: 404 }
  deleteRoom(slug)
  return { ok: true, status: 200 }
}
