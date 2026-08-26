/**
 * GET /rec/[slug]/server-copy/download?clientId=...
 *
 * Lets the host download one participant's finalized server-copy WAV
 * while the room is still active — the payoff of tickets 04/05. Host-only
 * (see `authorizeServerCopyHostRequest`), room-must-be-active (an
 * expired/deleted room is rejected exactly like `chunks`/`session`), and
 * copy-must-be-complete: `isServerCopyFinalized` is the same
 * file-on-disk-is-the-source-of-truth check `finalize` uses to decide
 * whether to (re)build, so an incomplete copy — upload never caught up,
 * or simply never finalized — can never be downloaded as if it were a
 * complete recording.
 *
 * Streams the WAV file rather than reading it fully into memory — a long
 * recording can be very large, and this route must never hold the whole
 * thing in the process's heap just to serve one download.
 */
import { json } from '@sveltejs/kit'
import { Readable } from 'stream'
import { createReadStream, statSync } from 'fs'
import { authorizeServerCopyHostRequest, isValidServerCopyClientId } from '$lib/server/server-copy-session.js'
import { getServerCopyWavPath, isServerCopyFinalized } from '$lib/server/server-copy-storage.js'

export async function GET({ params, url, cookies }) {
  const { slug } = params
  const auth = authorizeServerCopyHostRequest({ slug, cookies })
  if (!auth.ok) return json({ error: auth.reason }, { status: auth.status })

  const clientId = url.searchParams.get('clientId')
  if (!isValidServerCopyClientId(clientId)) {
    return json({ error: 'invalid-client-id' }, { status: 400 })
  }

  if (!isServerCopyFinalized(slug, clientId)) {
    return json({ error: 'not-finalized' }, { status: 404 })
  }

  const wavFile = getServerCopyWavPath(slug, clientId)
  const size = statSync(wavFile).size

  return new Response(Readable.toWeb(createReadStream(wavFile)), {
    headers: {
      'content-type': 'audio/wav',
      'content-length': String(size),
      'content-disposition': `attachment; filename="${encodeURIComponent(slug)}-${encodeURIComponent(clientId)}.wav"`
    }
  })
}
