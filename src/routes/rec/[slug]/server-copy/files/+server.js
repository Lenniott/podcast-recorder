/**
 * GET /rec/[slug]/server-copy/files
 *
 * Host-only index of every recoverable server-copy take for the active room.
 * Presence only knows the current/latest status; this route reads disk so
 * older stop/start takes remain discoverable and downloadable.
 */
import { json } from '@sveltejs/kit'
import { authorizeServerCopyHostRequest } from '$lib/server/server-copy-session.js'
import { listServerCopyFiles } from '$lib/server/server-copy-storage.js'

function downloadUrl(slug, entry) {
  const takeParam = entry.takeId ? `&takeId=${encodeURIComponent(entry.takeId)}` : ''
  return `/rec/${encodeURIComponent(slug)}/server-copy/download?clientId=${encodeURIComponent(entry.clientId)}${takeParam}`
}

export async function GET({ params, cookies }) {
  const { slug } = params
  const auth = authorizeServerCopyHostRequest({ slug, cookies })
  if (!auth.ok) return json({ error: auth.reason }, { status: auth.status })

  const groups = new Map()
  for (const entry of listServerCopyFiles(slug)) {
    if (!groups.has(entry.clientId)) groups.set(entry.clientId, [])
    groups.get(entry.clientId).push({
      ...entry,
      downloadUrl: downloadUrl(slug, entry)
    })
  }

  return json({
    groups: Array.from(groups.entries()).map(([clientId, entries]) => ({ clientId, entries }))
  })
}
