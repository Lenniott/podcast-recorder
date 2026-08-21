/**
 * Capture Writer — owns the WAV byte stream for one take.
 *
 * Chunks are queued and flushed in the background, decoupled from the
 * real-time cadence they arrive at: a slow disk just makes the queue
 * longer, it is never mistaken for a microphone dropout. Digital silence
 * is written ONLY when the caller reports an explicit gap (a real device
 * reconnect/swap) via notifyDeviceGap() — never inferred from how long a
 * write took.
 *
 * `write` is injected (a Blob/ArrayBuffer -> Promise<void> adapter), so
 * this is testable with an in-memory fake and, in the app, backed by a
 * FileSystemWritableFileStream.
 *
 * `onWritten(i16, sampleOffset)` is optional and fires only AFTER a chunk's
 * write() has actually resolved — never on writeChunk() being called. It's
 * the one seam anything that needs to show "what's really on disk" (a live
 * waveform, a listen-back preview) should hang off, instead of the live mic
 * signal — the write path is the thing that can silently break; the mic
 * never lies about what it's picking up.
 */
export function createCaptureWriter({ sampleRate, write, onWritten }) {
  if (!(sampleRate > 0)) throw new Error('createCaptureWriter: sampleRate must be > 0')
  if (typeof write !== 'function') throw new Error('createCaptureWriter: write must be a function')

  let tail = Promise.resolve()   // chain of queued writes, oldest-first
  let pending = 0                // writes queued but not yet flushed
  let samplesWritten = 0         // authoritative — only advances once a write resolves
  let dataByteCount = 0          // authoritative — mirrors samplesWritten in bytes
  let closed = false

  function enqueue(fn) {
    pending++
    tail = tail.then(fn).finally(() => { pending-- })
    return tail
  }

  /**
   * Queue one chunk of real PCM audio (Int16Array). Fire-and-forget by
   * design — callers that need to know the recording is still keeping up
   * should read `.pending`, not await this.
   * Returns the byte length that will be added once flushed, so a caller
   * can update a progress display immediately without waiting on disk I/O.
   */
  function writeChunk(i16) {
    if (closed || !i16 || i16.length === 0) return 0
    const bytes = i16.byteLength
    enqueue(async () => {
      await write(i16.buffer)
      const offset = samplesWritten
      samplesWritten += i16.length
      dataByteCount += bytes
      onWritten?.(i16, offset)
    })
    return bytes
  }

  /**
   * Report a REAL gap — a mic dropout, device swap, or reconnect — as
   * measured wall-clock seconds with no audio captured. Backfills that
   * exact duration as digital silence so the file's timeline stays
   * continuous. This is the only path that ever writes silence.
   */
  function notifyDeviceGap(durationSec) {
    if (closed || !(durationSec > 0)) return 0
    const gapSamples = Math.round(durationSec * sampleRate)
    if (gapSamples <= 0) return 0
    const bytes = gapSamples * 2 // Int16 = 2 bytes/sample
    enqueue(async () => {
      const silence = new Int16Array(gapSamples)
      await write(silence.buffer)
      const offset = samplesWritten
      samplesWritten += gapSamples
      dataByteCount += bytes
      onWritten?.(silence, offset)
    })
    return bytes
  }

  /** Resolves once every write queued so far (including ones queued while
   *  waiting) has actually completed. */
  async function drain() {
    while (pending > 0) {
      await tail.catch(() => {}) // a failed write shouldn't hang drain() forever
    }
  }

  /** Drains the queue and stops accepting further writes. Returns the
   *  final, authoritative sample/byte counts for the WAV header patch. */
  async function stop() {
    await drain()
    closed = true
    return { samplesWritten, dataByteCount }
  }

  return {
    writeChunk,
    notifyDeviceGap,
    drain,
    stop,
    get samplesWritten() { return samplesWritten },
    get dataByteCount() { return dataByteCount },
    get pending() { return pending }
  }
}
