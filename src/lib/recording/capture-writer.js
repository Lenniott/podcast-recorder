/** Ordered local PCM writes. Failed saves stop this destination; they never
 * count as confirmed audio or allow later chunks to skip past the failure. */
export function createCaptureWriter({ sampleRate, write, onWritten, onIssue, slowWriteMs = 1000, writeTimeoutMs = 20000 }) {
  if (!Number.isFinite(sampleRate) || !(sampleRate > 0)) throw new Error('createCaptureWriter: sampleRate must be > 0')
  if (typeof write !== 'function') throw new Error('createCaptureWriter: write must be a function')
  let tail = Promise.resolve()
  let pending = 0
  let samplesWritten = 0
  let dataByteCount = 0
  let closed = false
  let failure = null
  let slowReported = false

  function notify(fn, ...args) {
    try { Promise.resolve(fn?.(...args)).catch(() => {}) } catch { /* observers cannot break saving */ }
  }

  function writeChunk(input) {
    if (closed || failure || !input || input.length === 0) return 0
    // Own just the submitted samples, including when the input is a subarray.
    const samples = input.slice()
    const bytes = samples.byteLength
    pending++
    tail = tail.then(async () => {
      if (failure) return
      let slowTimer
      let timeoutTimer
      try {
        slowTimer = setTimeout(() => {
          if (slowReported) return
          slowReported = true
          notify(onIssue, { code: 'slow-write', severity: 'warning', destination: 'local', message: 'Local audio write is taking longer than expected.' })
        }, slowWriteMs)
        await Promise.race([
          Promise.resolve().then(() => write(samples.buffer)),
          new Promise((_, reject) => {
            timeoutTimer = setTimeout(() => reject(new Error('Local audio write timed out')), writeTimeoutMs)
          })
        ])
        const offset = samplesWritten
        samplesWritten += samples.length
        dataByteCount += bytes
        notify(onWritten, samples, offset)
      } catch (error) {
        failure = error
        notify(onIssue, { code: 'save-failed', severity: 'error', destination: 'local', message: 'Local audio save failed.', error })
      } finally {
        clearTimeout(slowTimer)
        clearTimeout(timeoutTimer)
      }
    }).finally(() => { pending-- })
    return bytes
  }

  async function drain() {
    while (pending > 0) await tail
    if (failure) throw failure
  }

  async function stop() {
    closed = true
    await drain()
    return { samplesWritten, dataByteCount }
  }

  return {
    writeChunk, drain, stop,
    get samplesWritten() { return samplesWritten },
    get dataByteCount() { return dataByteCount },
    get pending() { return pending }
  }
}
