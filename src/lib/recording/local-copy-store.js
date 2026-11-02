import { buildWavHeader } from './audio-utils.js'

/**
 * Local Copy in the browser's private file storage, one folder per room.
 * Every recording attempt is a new `-take-N.wav` written in place by
 * local-copy-worker.js. A take stays here until the person saves it out;
 * nothing in this module deletes a take except an explicit remove().
 */

const BASE_DIRECTORY = 'local-copy'
const WAV_HEADER_BYTES = 44

export function localCopySupported(scope = globalThis) {
  return typeof scope.navigator?.storage?.getDirectory === 'function' && typeof scope.Worker === 'function'
}

/** Must run synchronously inside a click: Firefox only asks from a user gesture. */
export function requestLocalCopyPersistence(storage = globalThis.navigator?.storage) {
  try {
    return Promise.resolve(storage?.persist?.() ?? false).catch(() => false)
  } catch {
    return Promise.resolve(false)
  }
}

export function attemptFileName({ participantName, roomName, now = new Date(), attempt }) {
  const safeParticipant = (participantName || 'guest').replace(/[^a-z0-9]/gi, '-').toLowerCase()
  const safeName = String(roomName || 'episode').replace(/[^a-z0-9]/gi, '-').toLowerCase()
  return `${safeParticipant}-${safeName}-${now.toISOString().slice(0, 10)}-take-${attempt}.wav`
}

export function takeNumber(name) {
  const match = /-take-(\d+)\.wav$/.exec(name || '')
  return match ? Number(match[1]) : null
}

/**
 * Confirm copy for removing a take from this browser. The page can't see
 * whether a download finished, so a clicked Save still asks them to check
 * the file first; a take never saved here says plainly it will be lost.
 */
export function localCopyRemoveMessage(take, saveClicked) {
  const label = `Take ${takeNumber(take?.name) ?? '?'}`
  return saveClicked
    ? `Remove ${label} from this browser? Only do this once the saved file opens on your computer.`
    : `${label} hasn't been saved from this page. Removing it deletes this recording from this browser. Remove anyway?`
}

/**
 * Reads a stored take from its own header and size. A header whose data
 * length disagrees with the bytes on disk is a take that never closed.
 * Returns null for anything that is not one of our WAVs or holds no audio.
 */
export function describeLocalCopy({ name, size, header }) {
  if (!header || header.byteLength < WAV_HEADER_BYTES || size <= WAV_HEADER_BYTES) return null
  const view = new DataView(header)
  const tag = (offset) => String.fromCharCode(...new Uint8Array(header, offset, 4))
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || tag(36) !== 'data') return null
  const sampleRate = view.getUint32(24, true)
  const blockAlign = view.getUint16(32, true)
  if (!(sampleRate > 0) || !(blockAlign > 0)) return null
  const onDisk = size - WAV_HEADER_BYTES
  const dataBytes = onDisk - (onDisk % blockAlign)
  if (dataBytes === 0) return null
  return {
    name,
    sampleRate,
    dataBytes,
    durationSeconds: dataBytes / (sampleRate * blockAlign),
    endedEarly: view.getUint32(40, true) !== dataBytes
  }
}

/** The WAV Save downloads: a header for the audio actually on disk, then that audio. */
export function localCopyWav(take, file) {
  return new Blob(
    [buildWavHeader(take.dataBytes, take.sampleRate), file.slice(WAV_HEADER_BYTES, WAV_HEADER_BYTES + take.dataBytes)],
    { type: 'audio/wav' }
  )
}

// A take left by an earlier visit must never be reopened: opening a writer
// on it would write over audio that may not have been saved yet.
async function fileExists(directory, name) {
  try {
    await directory.getFileHandle(name)
    return true
  } catch (err) {
    if (err?.name === 'NotFoundError') return false
    throw err
  }
}

/** Worker-backed file with the subset of a writable stream the capture session uses. */
export function createWorkerFiles({ createWorker }) {
  let worker = null
  let broken = null
  let nextId = 0
  const pending = new Map()

  function failAll(error) {
    broken = error
    for (const { reject } of pending.values()) reject(error)
    pending.clear()
  }

  function start() {
    const created = createWorker()
    created.onmessage = ({ data }) => {
      const entry = pending.get(data?.id)
      if (!entry) return
      pending.delete(data.id)
      if (data.ok) entry.resolve()
      else entry.reject(Object.assign(new Error(data.error?.message || 'Local Copy write failed'), { name: data.error?.name || 'Error' }))
    }
    created.onerror = (event) => {
      event?.preventDefault?.()
      failAll(new Error(event?.message || 'Local Copy worker failed'))
    }
    return created
  }

  function request(message) {
    if (broken) return Promise.reject(broken)
    worker ??= start()
    const id = ++nextId
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      // Copied, not transferred: the caller keeps reading these samples after the write.
      worker.postMessage({ ...message, id })
    })
  }

  async function open({ room, name }) {
    await request({ op: 'open', room, name })
    let position = 0
    return {
      async write(data) {
        const bytes = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
        await request({ op: 'write', room, name, position, bytes })
        position += bytes.byteLength
      },
      async seek(to) {
        position = to
      },
      close: () => request({ op: 'close', room, name }),
      abort: () => request({ op: 'abort', room, name })
    }
  }

  // Load the worker while joining online, so first Record still works if the
  // connection drops before any take has opened. This creates no audio file.
  try { worker = start() } catch (error) { failAll(error) }
  return { open }
}

export function createLocalCopyStore({
  slug,
  getRoot = () => navigator.storage.getDirectory(),
  workerFiles = createWorkerFiles({
    createWorker: () => new Worker(new URL('./local-copy-worker.js', import.meta.url), { type: 'module' })
  })
}) {
  const room = String(slug || 'room').replace(/[^a-z0-9_-]/gi, '-')
  let attempts = 0

  async function directory() {
    const root = await getRoot()
    const base = await root.getDirectoryHandle(BASE_DIRECTORY, { create: true })
    return base.getDirectoryHandle(room, { create: true })
  }

  async function openNext(options = {}) {
    const folder = await directory()
    let name
    do {
      attempts += 1
      name = attemptFileName({ ...options, attempt: attempts })
    } while (await fileExists(folder, name))
    await folder.getFileHandle(name, { create: true })
    const file = await workerFiles.open({ room, name })
    return { attempt: attempts, name, file }
  }

  /** Every take with audio in this room's folder, oldest first. A take still being written by this page belongs in `exclude`. */
  async function list({ exclude = [], onUnreadable } = {}) {
    const folder = await directory()
    const takes = []
    for await (const [name, handle] of folder.entries()) {
      if (handle.kind !== 'file' || exclude.includes(name)) continue
      try {
        const file = await handle.getFile()
        const take = describeLocalCopy({ name, size: file.size, header: await file.slice(0, WAV_HEADER_BYTES).arrayBuffer() })
        if (take) takes.push({ ...take, file, lastModified: file.lastModified })
      } catch (error) {
        onUnreadable?.({ name, error })
      }
    }
    return takes.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  }

  async function remove(name) {
    const folder = await directory()
    await folder.removeEntry(name)
  }

  return { room, openNext, list, remove }
}
