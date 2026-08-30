/**
 * GET /rec/[slug]/server-copy/download?clientId=...
 *
 * Lets the host download one participant's server-copy WAV while the room
 * is still active. Host-only (see `authorizeServerCopyHostRequest`) and
 * room-must-be-active (an expired/deleted room is rejected exactly like
 * `chunks`/`session`).
 *
 * If finalize has already built the completed WAV, this streams that file.
 * If upload failed or is still in progress, this still recovers every PCM
 * byte durably accepted so far by streaming a WAV header for the current
 * PCM length followed by the raw PCM file. That partial WAV is not the
 * complete take, but it is continuous and playable up to the last chunk
 * the server confirmed.
 *
 * Streams the WAV file rather than reading it fully into memory — a long
 * recording can be very large, and this route must never hold the whole
 * thing in the process's heap just to serve one download.
 */
import { json } from '@sveltejs/kit'
import { Readable } from 'stream'
import { createReadStream, existsSync, statSync } from 'fs'
import { authorizeServerCopyHostRequest, isValidServerCopyClientId } from '$lib/server/server-copy-session.js'
import {
  findLatestServerCopyTakeId,
  getServerCopyBytesWritten,
  getServerCopyFilePath,
  getServerCopySampleRate,
  getServerCopyWavPath,
  isServerCopyFinalized
} from '$lib/server/server-copy-storage.js'
import { buildWavHeader } from '$lib/audio-utils.js'

export async function GET({ params, url, cookies }) {
  const { slug } = params
  const auth = authorizeServerCopyHostRequest({ slug, cookies })
  if (!auth.ok) return json({ error: auth.reason }, { status: auth.status })

  const clientId = url.searchParams.get('clientId')
  if (!isValidServerCopyClientId(clientId)) {
    return json({ error: 'invalid-client-id' }, { status: 400 })
  }
  let takeId = url.searchParams.get('takeId')
  if (takeId != null && !isValidServerCopyClientId(takeId)) {
    return json({ error: 'invalid-take-id' }, { status: 400 })
  }

  let finalized = isServerCopyFinalized(slug, clientId, takeId)
  if (!takeId && !finalized) {
    const latestFinalizedTakeId = findLatestServerCopyTakeId(slug, clientId, 'wav')
    if (latestFinalizedTakeId) {
      takeId = latestFinalizedTakeId
      finalized = true
    }
  }
  const wavFile = getServerCopyWavPath(slug, clientId, takeId)
  if (finalized) {
    const size = statSync(wavFile).size

    return new Response(Readable.toWeb(createReadStream(wavFile)), {
      headers: {
        'content-type': 'audio/wav',
        'content-length': String(size),
        'content-disposition': `attachment; filename="${encodeURIComponent(slug)}-${encodeURIComponent(clientId)}.wav"`
      }
    })
  }

  let pcmFile = getServerCopyFilePath(slug, clientId, takeId)
  if (!takeId && !existsSync(pcmFile)) {
    const latestPartialTakeId = findLatestServerCopyTakeId(slug, clientId, 'pcm')
    if (latestPartialTakeId) {
      takeId = latestPartialTakeId
      pcmFile = getServerCopyFilePath(slug, clientId, takeId)
    }
  }
  if (!existsSync(pcmFile)) {
    return json({ error: 'no-server-copy' }, { status: 404 })
  }

  const dataBytes = getServerCopyBytesWritten(slug, clientId, takeId)
  const sampleRate = getServerCopySampleRate(slug, clientId, takeId)
  const header = Buffer.from(buildWavHeader(dataBytes, sampleRate))
  const stream = Readable.from((async function * () {
    yield header
    yield * createReadStream(pcmFile)
  })())

  return new Response(Readable.toWeb(stream), {
    headers: {
      'content-type': 'audio/wav',
      'content-length': String(header.length + dataBytes),
      'content-disposition': `attachment; filename="${encodeURIComponent(slug)}-${encodeURIComponent(clientId)}-partial.wav"`
    }
  })
}
