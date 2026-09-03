import {
  appendFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync
} from 'fs'
import { dirname, resolve, sep } from 'path'
import { once } from 'events'
import { pipeline } from 'stream/promises'
import { buildWavHeader } from '../recording/audio-utils.js'

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
function serverCopyFileKey(clientId, takeId) {
  return takeId ? `${String(clientId || '')}__${String(takeId)}` : String(clientId || '')
}

function parseServerCopyFileName(name) {
  const match = String(name || '').match(/^(.+)\.(pcm|wav)$/)
  if (!match) return null
  const key = match[1]
  const extension = match[2]
  const separator = key.indexOf('__')
  if (separator === -1) return { clientId: key, takeId: null, extension }
  return {
    clientId: key.slice(0, separator),
    takeId: key.slice(separator + 2),
    extension
  }
}

function resolveServerCopyFile(slug, clientId, extension, takeId) {
  const dir = getServerCopyRoomDir(slug)
  const file = resolve(dir, `${serverCopyFileKey(clientId, takeId)}.${extension}`)
  if (file.startsWith(dir + sep) && dirname(file) === dir) return file
  throw new Error('Invalid clientId for server-copy storage')
}

/** Raw-PCM upload target — see appendServerCopyChunk. */
export function getServerCopyFilePath(slug, clientId, takeId) {
  return resolveServerCopyFile(slug, clientId, 'pcm', takeId)
}

/** Finalized, playable WAV — only ever created by finalizeServerCopy. */
export function getServerCopyWavPath(slug, clientId, takeId) {
  return resolveServerCopyFile(slug, clientId, 'wav', takeId)
}

export function findLatestServerCopyTakeId(slug, clientId, extension = 'wav') {
  const dir = getServerCopyRoomDir(slug)
  if (!existsSync(dir)) return null

  const prefix = `${String(clientId || '')}__`
  const suffix = `.${extension}`
  let latest = null
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue
    const takeId = name.slice(prefix.length, -suffix.length)
    if (!takeId) continue
    const file = resolve(dir, name)
    const mtimeMs = statSync(file).mtimeMs
    if (!latest || mtimeMs > latest.mtimeMs) latest = { takeId, mtimeMs }
  }
  return latest?.takeId || null
}

export function listServerCopyFiles(slug) {
  const dir = getServerCopyRoomDir(slug)
  if (!existsSync(dir)) return []

  const byTake = new Map()
  for (const name of readdirSync(dir)) {
    const parsed = parseServerCopyFileName(name)
    if (!parsed || !parsed.clientId) continue
    const { clientId, takeId, extension } = parsed
    const key = `${clientId}\0${takeId || ''}`
    const file = resolve(dir, name)
    if (!file.startsWith(dir + sep) || dirname(file) !== dir) continue
    const stat = statSync(file)
    const current = byTake.get(key) || { clientId, takeId, files: {} }
    current.files[extension] = {
      size: stat.size,
      createdAt: new Date(stat.birthtimeMs || stat.ctimeMs || stat.mtimeMs).toISOString(),
      updatedAt: new Date(stat.mtimeMs).toISOString()
    }
    byTake.set(key, current)
  }

  return Array.from(byTake.values())
    .map(({ clientId, takeId, files }) => {
      const complete = files.wav
      const partial = files.pcm
      const chosen = complete || partial
      if (!chosen) return null
      const sampleRate = getServerCopySampleRate(slug, clientId, takeId)
      const status = complete ? 'complete' : 'partial'
      const byteSize = complete ? complete.size : partial.size + 44
      return {
        clientId,
        takeId,
        status,
        byteSize,
        sampleRate,
        createdAt: chosen.createdAt,
        updatedAt: chosen.updatedAt
      }
    })
    .filter(Boolean)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
}

function getServerCopyMetadataPath(slug, clientId, takeId) {
  return resolveServerCopyFile(slug, clientId, 'json', takeId)
}

export function writeServerCopyMetadata(slug, clientId, { sampleRate, takeId } = {}) {
  const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? Math.round(sampleRate) : undefined
  if (!rate) return
  const file = getServerCopyMetadataPath(slug, clientId, takeId)
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, JSON.stringify({ sampleRate: rate }) + '\n')
}

export function getServerCopySampleRate(slug, clientId, takeId) {
  try {
    const lines = readFileSync(getServerCopyMetadataPath(slug, clientId, takeId), 'utf8').trim().split('\n')
    const last = JSON.parse(lines.at(-1) || '{}')
    return Number.isFinite(last.sampleRate) && last.sampleRate > 0 ? last.sampleRate : 48000
  } catch (e) {
    if (e.code === 'ENOENT') return 48000
    return 48000
  }
}

/**
 * Bytes already durably appended for this participant's server copy. The
 * file on disk is the single source of truth — no in-memory session state
 * to reconcile, so this is accurate even right after a server restart.
 */
export function getServerCopyBytesWritten(slug, clientId, takeId) {
  try {
    return statSync(getServerCopyFilePath(slug, clientId, takeId)).size
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
export function appendServerCopyChunk(slug, clientId, buffer, expectedOffset, { takeId } = {}) {
  if (isServerCopyFinalized(slug, clientId, takeId)) {
    const err = new Error(`server-copy for ${clientId} is already finalized; no further chunks accepted`)
    err.code = 'ALREADY_FINALIZED'
    throw err
  }

  const file = getServerCopyFilePath(slug, clientId, takeId)
  const currentBytes = getServerCopyBytesWritten(slug, clientId, takeId)
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
export function isServerCopyFinalized(slug, clientId, takeId) {
  try {
    statSync(getServerCopyWavPath(slug, clientId, takeId))
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
export async function finalizeServerCopy(slug, clientId, { sampleRate, takeId } = {}) {
  const pcmFile = getServerCopyFilePath(slug, clientId, takeId)
  const wavFile = getServerCopyWavPath(slug, clientId, takeId)
  const tmpFile = `${wavFile}.tmp`
  const dataBytes = getServerCopyBytesWritten(slug, clientId, takeId)

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
