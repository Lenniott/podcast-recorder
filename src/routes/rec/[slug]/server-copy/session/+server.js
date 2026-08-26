/**
 * POST /rec/[slug]/server-copy/session
 *
 * Accepts (or rejects) a server-copy upload session for one participant of
 * an active room. This is the "a server-copy session has been accepted"
 * gate the client module (`$lib/server-copy-upload.js`) must see succeed
 * before it ever sends chunk bytes — see ticket 04.
 *
 * There is deliberately no in-memory session object created here: the
 * participant's server-copy file on disk *is* the session's state
 * (`getServerCopyBytesWritten`), so "acceptance" is just this request
 * succeeding, and there's nothing to lose or reconcile if the room's
 * WebSocket reconnects in the meantime — this endpoint doesn't touch it.
 */
import { json } from '@sveltejs/kit'
import { authorizeServerCopyRequest, isValidServerCopyClientId } from '$lib/server/server-copy-session.js'
import { getServerCopyBytesWritten } from '$lib/server/server-copy-storage.js'

export async function POST({ params, request, cookies }) {
  const { slug } = params
  const auth = authorizeServerCopyRequest({ slug, cookies })
  if (!auth.ok) return json({ accepted: false, reason: auth.reason }, { status: auth.status })

  let body
  try { body = await request.json() } catch { body = {} }
  const clientId = body?.clientId

  if (!isValidServerCopyClientId(clientId)) {
    return json({ accepted: false, reason: 'invalid-client-id' }, { status: 400 })
  }

  return json({ accepted: true, bytesWritten: getServerCopyBytesWritten(slug, clientId) })
}
