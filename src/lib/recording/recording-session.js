import { createCaptureWriter } from './capture-writer.js'
import { buildWavHeader } from './audio-utils.js'

/** Coordinates one take. Issues are data for the caller; save failures also
 * request Stop. Destination completion is independent and never inferred. */
export function createRecordingSession({ sampleRate, file, upload, stopCapture, onWritten, onIssue,
  onStopRequested, onLocalFinished, slowWriteMs = 1000, writeTimeoutMs = 20000 }) {
  let accepting = true
  let stopPromise = null
  const reported = new Set()

  function reportIssue(issue) {
    const key = `${issue.destination}:${issue.code}`
    if (reported.has(key)) return
    reported.add(key)
    try { onIssue?.(issue) } catch { /* reporting is not part of saving */ }
    if (issue.code === 'save-failed') {
      void stop()
      try { onStopRequested?.() } catch { /* capture still stops if the observer fails */ }
    }
  }

  const writer = createCaptureWriter({ sampleRate, write: bytes => file.write(bytes), onWritten,
    onIssue: reportIssue, slowWriteMs, writeTimeoutMs })

  function writeChunk(samples) {
    if (!accepting || !samples?.length) return 0
    // Silence is valid audio, not evidence that the selected mic disconnected.
    // Neither submission may prevent the other destination receiving this chunk.
    try { upload.handleChunk(samples) } catch (error) {
      reportIssue({ code: 'save-failed', severity: 'error', destination: 'server', message: 'Server audio submission failed.', error })
    }
    return writer.writeChunk(samples)
  }

  async function completeLocal() {
    let timer
    let expired = false
    try {
      const { dataByteCount } = await writer.stop()
      await Promise.race([
        (async () => {
          await file.seek(0)
          if (expired) return
          await file.write(buildWavHeader(dataByteCount, sampleRate))
          if (expired) return
          await file.close()
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => { expired = true; reject(new Error('Local file finalization timed out')) }, writeTimeoutMs) })
      ])
      return { saved: true, dataByteCount }
    } catch (error) {
      try { Promise.resolve(file.abort?.()).catch(() => {}) } catch { /* already errored */ }
      reportIssue({ code: 'save-failed', severity: 'error', destination: 'local', message: 'Local recording could not be saved.', error })
      return { saved: false, error }
    } finally { clearTimeout(timer) }
  }

  async function completeServer() {
    try {
      if (!await upload.finish()) throw new Error('Server recording could not be finalized')
      return { saved: true }
    } catch (error) {
      reportIssue({ code: 'save-failed', severity: 'error', destination: 'server', message: 'Server recording could not be saved.', error })
      return { saved: false, error }
    }
  }

  let resolveLocalFinished
  // Resolves when this take's local file is closed, even if the server
  // copy is still finishing. A retake waits on this and opens the next
  // file; it does not wait on the upload.
  const whenLocalFinished = new Promise(resolve => { resolveLocalFinished = resolve })

  async function finish({ capture = true } = {}) {
    let captureError = null
    if (capture) {
      try { await stopCapture() } catch (error) {
        captureError = error
        reportIssue({ code: 'capture-stop-failed', severity: 'error', destination: 'capture', message: 'Capture stopped without confirming the final audio chunk.', error })
      }
    }
    accepting = false
    const localDone = completeLocal().then(result => {
      try { onLocalFinished?.(result) } catch { /* observers cannot block the other destination */ }
      resolveLocalFinished(result)
      return result
    })
    const [local, server] = await Promise.all([localDone, completeServer()])
    return { local, server, captureError }
  }

  function stop(options) {
    if (!stopPromise) stopPromise = Promise.resolve().then(() => finish(options))
    return stopPromise
  }
  return {
    writeChunk, stop, reportIssue, whenLocalFinished,
    get samplesWritten() { return writer.samplesWritten }
  }
}
