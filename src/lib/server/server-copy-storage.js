import { appendFileSync, mkdirSync, rmSync, statSync } from 'fs'
import { dirname, resolve, sep } from 'path'

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
 * Path to one participant's raw-PCM server-copy file within a room's
 * directory — sanitized the same way as the room dir itself (resolve +
 * startsWith check), and additionally pinned to a direct child of that
 * directory, so a hostile clientId can never escape it or land in a
 * nested path.
 */
export function getServerCopyFilePath(slug, clientId) {
  const dir = getServerCopyRoomDir(slug)
  const file = resolve(dir, `${String(clientId || '')}.pcm`)
  if (file.startsWith(dir + sep) && dirname(file) === dir) return file
  throw new Error('Invalid clientId for server-copy storage')
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
 */
export function appendServerCopyChunk(slug, clientId, buffer, expectedOffset) {
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
