/**
 * POST /rec/[slug]/server-copy/chunks?clientId=...&offset=<bytesAlreadyAcked>
 *
 * Appends one chunk of already-confirmed-written local audio (raw PCM
 * bytes, exactly what capture-writer.js handed to its onWritten seam — see
 * $lib/server-copy-upload.js) to that participant's server-copy file.
 *
 * Rejects the same way as the session endpoint for an inactive room or a
 * missing/invalid room cookie (ticket 02: upload/download only for an
 * active room). `offset` must equal the byte count already durably on
 * disk for this participant, or the append is refused outright
 * (server-copy-storage's OFFSET_MISMATCH) — this is a strict, ordered,
 * non-resumable append, never a random-access write, so a duplicate or
 * out-of-order request can never corrupt the file.
 */
import { json } from '@sveltejs/kit'
import { authorizeServerCopyRequest, isValidServerCopyClientId } from '$lib/server/server-copy-session.js'
import { appendServerCopyChunk } from '$lib/server/server-copy-storage.js'

export async function POST({ params, request, cookies, url }) {
  const { slug } = params
  const auth = authorizeServerCopyRequest({ slug, cookies })
  if (!auth.ok) return json({ error: auth.reason }, { status: auth.status })

  const clientId = url.searchParams.get('clientId')
  if (!isValidServerCopyClientId(clientId)) {
    return json({ error: 'invalid-client-id' }, { status: 400 })
  }

  const offset = Number.parseInt(url.searchParams.get('offset'), 10)
  if (!Number.isInteger(offset) || offset < 0) {
    return json({ error: 'invalid-offset' }, { status: 400 })
  }

  const buffer = Buffer.from(await request.arrayBuffer())
  if (buffer.length === 0) return json({ error: 'empty-chunk' }, { status: 400 })

  try {
    const bytesWritten = appendServerCopyChunk(slug, clientId, buffer, offset)
    return json({ bytesWritten })
  } catch (e) {
    if (e.code === 'OFFSET_MISMATCH') {
      return json({ error: 'offset-mismatch', bytesWritten: e.currentBytes }, { status: 409 })
    }
    throw e
  }
}
