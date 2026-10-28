import { createCaptureWriter } from './capture-writer.js'
import { buildWavHeader } from './audio-utils.js'
import { SIGNAL_RMS } from './microphones.js'

/** Coordinates one take. Issues are data for the caller; save failures also
 * request Stop. Destination completion is independent and never inferred. */
export function createRecordingSession({ sampleRate, file, upload, stopCapture, onWritten, onIssue,
  onStopRequested, onLocalFinished, onMicrophoneNeeded, noSignalSeconds = 3, slowWriteMs = 1000, writeTimeoutMs = 20000 }) {
  let accepting = true
  let stopPromise = null
  let silentSamples = 0
  let noSignalSettled = false
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

  function hasSignal(samples) {
    let sum = 0
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i] / 32768
      sum += s * s
    }
    return Math.sqrt(sum / samples.length) > SIGNAL_RMS
  }

  function writeChunk(samples) {
    if (!accepting || !samples?.length) return 0
    if (hasSignal(samples)) {
      silentSamples = 0
      noSignalSettled = false
    } else if (!noSignalSettled) {
      silentSamples += samples.length
      if (silentSamples >= noSignalSeconds * sampleRate) {
        silentSamples = 0
        noSignalSettled = true
        let switched
        try { switched = onMicrophoneNeeded?.() } catch { /* connecting cannot block saving */ }
        if (switched && typeof switched.then === 'function') {
          switched.then(ok => { noSignalSettled = ok === false }, () => { noSignalSettled = false })
        } else {
          noSignalSettled = switched === false
        }
      }
    }
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

  async function finish() {
    let captureError = null
    try { await stopCapture() } catch (error) {
      captureError = error
      reportIssue({ code: 'capture-stop-failed', severity: 'error', destination: 'capture', message: 'Capture stopped without confirming the final audio chunk.', error })
    }
    accepting = false
    const localDone = completeLocal().then(result => {
      try { onLocalFinished?.(result) } catch { /* observers cannot block the other destination */ }
      return result
    })
    const [local, server] = await Promise.all([localDone, completeServer()])
    return { local, server, captureError }
  }

  function stop() {
    if (!stopPromise) stopPromise = Promise.resolve().then(finish)
    return stopPromise
  }
  return { writeChunk, stop, reportIssue }
}
