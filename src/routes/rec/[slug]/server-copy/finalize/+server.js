/**
 * POST /rec/[slug]/server-copy/finalize
 *
 * The explicit "this participant's server copy is done" signal — see
 * ticket 05. Turns the raw PCM bytes already durably on disk
 * (`server-copy/chunks`, see `$lib/server/server-copy-storage.js`) into a
 * complete, playable WAV file, but ONLY once `totalBytes` (the final,
 * confirmed-written local recording length the client already tracks —
 * see `$lib/server-copy-upload.js`'s `confirmedBytes`) matches the byte
 * count actually durable on disk for this participant. Finalization is
 * therefore never inferred from the HTTP connection closing, from the
 * chunks route going quiet, or from a timer — only from this explicit
 * request declaring the true final length, compared against what has
 * really landed on disk.
 *
 * If fewer bytes are on disk than declared, upload hasn't caught up yet
 * (or gave up, per server-copy-upload.js's no-resumable-upload design) —
 * this refuses (409) rather than ever finalizing an incomplete copy.
 * Calling finalize again with the length it was already finalized at is a
 * no-op success (the WAV is built once, not on every request); a
 * different length on a second call is refused, since an already-built
 * WAV is never silently rebuilt/overwritten.
 *
 * Same authorization as session/chunks — the uploading participant's own
 * room cookie, not a host-only check (that's the download route).
 */
import { json } from '@sveltejs/kit'
import { authorizeServerCopyRequest, isValidServerCopyClientId } from '$lib/server/server-copy-session.js'
import {
  getServerCopyBytesWritten,
  isServerCopyFinalized,
  finalizeServerCopy
} from '$lib/server/server-copy-storage.js'

export async function POST({ params, request, cookies }) {
  const { slug } = params
  const auth = authorizeServerCopyRequest({ slug, cookies })
  if (!auth.ok) return json({ finalized: false, reason: auth.reason }, { status: auth.status })

  let body
  try { body = await request.json() } catch { body = {} }
  const clientId = body?.clientId

  if (!isValidServerCopyClientId(clientId)) {
    return json({ finalized: false, reason: 'invalid-client-id' }, { status: 400 })
  }

  const totalBytes = body?.totalBytes
  if (!Number.isInteger(totalBytes) || totalBytes < 0) {
    return json({ finalized: false, reason: 'invalid-total-bytes' }, { status: 400 })
  }

  const currentBytes = getServerCopyBytesWritten(slug, clientId)

  if (isServerCopyFinalized(slug, clientId)) {
    if (currentBytes === totalBytes) return json({ finalized: true, bytesWritten: currentBytes })
    return json({ finalized: false, reason: 'already-finalized', bytesWritten: currentBytes }, { status: 409 })
  }

  if (currentBytes !== totalBytes) {
    return json({ finalized: false, reason: 'incomplete', bytesWritten: currentBytes }, { status: 409 })
  }

  const sampleRate = Number.isFinite(body?.sampleRate) && body.sampleRate > 0 ? body.sampleRate : undefined
  await finalizeServerCopy(slug, clientId, { sampleRate })

  return json({ finalized: true, bytesWritten: currentBytes })
}
