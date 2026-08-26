import {
  appendFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync
} from 'fs'
import { dirname, resolve, sep } from 'path'
import { once } from 'events'
import { pipeline } from 'stream/promises'
import { buildWavHeader } from '../audio-utils.js'

function serverCopyRoot() {
  return resolve(process.env.SERVER_COPY_DIR || './data/server-copies')
}

export function getServerCopyRoomDir(slug) {
  const root = serverCopyRoot()
  const dir = resolve(root, String(slug || ''))
  if (dir !== root && dir.startsWith(root + sep)) return dir
  throw new Error('Invalid room slug for server-copy storage')
}

export function removeServerCopiesForRoom(slug) {
  rmSync(getServerCopyRoomDir(slug), { recursive: true, force: true })
}

/**
 * Path to one participant's file within a room's directory, sanitized the
 * same way as the room dir itself (resolve + startsWith check) and
 * additionally pinned to a direct child of that directory, so a hostile
 * clientId can never escape it or land in a nested path. Shared by the
 * raw-PCM upload target and the finalized-WAV download target so the two
 * can never drift on how a clientId gets turned into a path.
 */
function resolveServerCopyFile(slug, clientId, extension) {
  const dir = getServerCopyRoomDir(slug)
  const file = resolve(dir, `${String(clientId || '')}.${extension}`)
  if (file.startsWith(dir + sep) && dirname(file) === dir) return file
  throw new Error('Invalid clientId for server-copy storage')
}

/** Raw-PCM upload target — see appendServerCopyChunk. */
export function getServerCopyFilePath(slug, clientId) {
  return resolveServerCopyFile(slug, clientId, 'pcm')
}

/** Finalized, playable WAV — only ever created by finalizeServerCopy. */
export function getServerCopyWavPath(slug, clientId) {
  return resolveServerCopyFile(slug, clientId, 'wav')
}

/**
 * Bytes already durably appended for this participant's server copy. The
 * file on disk is the single source of truth — no in-memory session state
 * to reconcile, so this is accurate even right after a server restart.
 */
export function getServerCopyBytesWritten(slug, clientId) {
  try {
    return statSync(getServerCopyFilePath(slug, clientId)).size
  } catch (e) {
    if (e.code === 'ENOENT') return 0
    throw e
  }
}

/**
 * Append one chunk to a participant's server-copy file — strictly
 * append-only, never random-access. `expectedOffset` must equal the byte
 * count already on disk, or the chunk is rejected untouched: this is what
 * keeps a retried or out-of-order request from ever duplicating or
 * corrupting bytes already confirmed, without needing any separate
 * in-memory "upload session" bookkeeping (the file's size *is* the
 * session's state). Returns the new total byte count on success.
 *
 * Once finalizeServerCopy has produced this participant's WAV (see
 * below), the PCM file is frozen — further chunks are rejected outright
 * rather than silently accepted and orphaned, so "finalized" always means
 * the WAV on disk is the complete, final recording.
 */
export function appendServerCopyChunk(slug, clientId, buffer, expectedOffset) {
  if (isServerCopyFinalized(slug, clientId)) {
    const err = new Error(`server-copy for ${clientId} is already finalized; no further chunks accepted`)
    err.code = 'ALREADY_FINALIZED'
    throw err
  }

  const file = getServerCopyFilePath(slug, clientId)
  const currentBytes = getServerCopyBytesWritten(slug, clientId)
  if (expectedOffset !== currentBytes) {
    const err = new Error(
      `server-copy chunk offset ${expectedOffset} does not match ${currentBytes} bytes already on disk`
    )
    err.code = 'OFFSET_MISMATCH'
    err.currentBytes = currentBytes
    throw err
  }
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, buffer)
  return currentBytes + buffer.length
}

/**
 * Whether this participant's server copy has been turned into a complete,
 * playable WAV yet. The finalized WAV file's presence on disk *is* that
 * state — same "file is the single source of truth" approach as
 * getServerCopyBytesWritten — so it's accurate even right after a server
 * restart, with nothing else to reconcile.
 */
export function isServerCopyFinalized(slug, clientId) {
  try {
    statSync(getServerCopyWavPath(slug, clientId))
    return true
  } catch (e) {
    if (e.code === 'ENOENT') return false
    throw e
  }
}

/**
 * Turn the raw PCM bytes already durably on disk for this participant
 * into a complete, standalone WAV file — once, at finalize time, not on
 * every download. Streams the (potentially very large) PCM file straight
 * into the WAV rather than holding it in memory, and writes to a temp
 * path then renames into place atomically, so a crash mid-write can never
 * leave a half-written file where isServerCopyFinalized would see it as
 * complete.
 *
 * `sampleRate` must match what the local writer actually recorded at
 * (see capture-writer.js / audio-utils.js's buildWavHeader, the same
 * header builder used here) — mono 16-bit PCM is the only format
 * capture-writer ever produces, so channel count and bit depth need no
 * parameter.
 */
export async function finalizeServerCopy(slug, clientId, { sampleRate } = {}) {
  const pcmFile = getServerCopyFilePath(slug, clientId)
  const wavFile = getServerCopyWavPath(slug, clientId)
  const tmpFile = `${wavFile}.tmp`
  const dataBytes = getServerCopyBytesWritten(slug, clientId)

  mkdirSync(dirname(wavFile), { recursive: true })
  try {
    const out = createWriteStream(tmpFile)
    out.write(Buffer.from(buildWavHeader(dataBytes, sampleRate)))
    if (existsSync(pcmFile)) {
      await pipeline(createReadStream(pcmFile), out)
    } else {
      out.end()
      await once(out, 'finish')
    }
    renameSync(tmpFile, wavFile)
  } catch (e) {
    rmSync(tmpFile, { force: true })
    throw e
  }
  return { wavFile, dataBytes }
}
