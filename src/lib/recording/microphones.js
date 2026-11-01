/** Linear RMS at or below this is no signal. About −80 dBFS. */
export const SIGNAL_RMS = 0.0001

/** Signal evidence is not a microphone quality score. A silent room and a dead
 * input can both produce zeros, so no-signal devices remain selectable. */
export function rankMicrophones(devices, preferredId) {
  const priority = { signal: 0, 'no-signal': 1, unchecked: 2, unavailable: 3 }
  return [...devices].sort((a, b) =>
    (priority[a.status] ?? 2) - (priority[b.status] ?? 2) ||
    Number(b.deviceId === preferredId) - Number(a.deviceId === preferredId))
}

export async function listMicrophones(mediaDevices = navigator.mediaDevices) {
  return (await mediaDevices.enumerateDevices()).filter(device => device.kind === 'audioinput')
}

export function watchMicrophoneDisconnect(track, onDisconnect) {
  let fired = false
  const ended = () => { if (!fired) { fired = true; onDisconnect() } }
  track.addEventListener?.('ended', ended)
  if (!track.addEventListener) track.onended = ended
  return () => {
    track.removeEventListener?.('ended', ended)
    if (track.onended === ended) track.onended = null
  }
}

const RAW_INPUT = {
  echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1
}

function releaseStream(stream) {
  stream.getTracks().forEach(track => track.stop())
}

export async function openMicrophone(deviceId, mediaDevices = navigator.mediaDevices, timeoutMs = 3000) {
  let expired = false
  let timer
  // Name the device alone. macOS Chrome captures the system default input when
  // processing is disabled in this same call, so raw-audio constraints are
  // applied only after the requested device is open.
  const opening = mediaDevices.getUserMedia({ audio: {
    deviceId: deviceId ? { exact: deviceId } : undefined
  } }).then(async stream => {
    if (expired) { releaseStream(stream); throw new Error('Microphone opened after timeout') }
    const track = stream.getAudioTracks()[0]
    if (track?.applyConstraints) {
      try { await track.applyConstraints(RAW_INPUT) }
      catch {
        if (expired) { releaseStream(stream); throw new Error('Microphone opened after timeout') }
      }
    }
    if (expired) { releaseStream(stream); throw new Error('Microphone opened after timeout') }
    return stream
  })
  try {
    return await Promise.race([opening, new Promise((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(new Error('Microphone did not open in time')) }, timeoutMs)
    })])
  } finally { clearTimeout(timer) }
}

/** Probe a separate stream; it never replaces or stops the recording input. */
export async function assessMicrophone(device, { audioContext, mediaDevices = navigator.mediaDevices, stream: activeStream, durationMs = 500 } = {}) {
  let stream
  let source
  let analyser
  let sink
  try {
    stream = activeStream ?? await openMicrophone(device.deviceId, mediaDevices)
    const track = stream.getAudioTracks()[0]
    if (!track || track.readyState === 'ended') throw new Error('No live audio track')
    if (audioContext.state !== 'running') throw new Error('Audio processing is not running')
    source = audioContext.createMediaStreamSource(stream)
    analyser = audioContext.createAnalyser()
    analyser.fftSize = 2048
    sink = audioContext.createGain()
    sink.gain.value = 0
    source.connect(analyser)
    analyser.connect(sink)
    sink.connect(audioContext.destination)
    const samples = new Float32Array(analyser.fftSize)
    let peak = 0
    let sum = 0
    let count = 0
    const measurements = Math.max(1, Math.ceil(durationMs / 50))
    for (let i = 0; i < measurements; i++) {
      await new Promise(resolve => setTimeout(resolve, durationMs / measurements))
      analyser.getFloatTimeDomainData(samples)
      for (const sample of samples) { peak = Math.max(peak, Math.abs(sample)); sum += sample * sample; count++ }
    }
    if (track.readyState === 'ended') throw new Error('Microphone disconnected during assessment')
    const rms = Math.sqrt(sum / count)
    return { deviceId: device.deviceId, label: device.label, status: rms > SIGNAL_RMS ? 'signal' : 'no-signal',
      rms, peak, settings: track.getSettings?.() ?? {} }
  } catch (error) {
    return { deviceId: device.deviceId, label: device.label, status: 'unavailable', error: error.message }
  } finally {
    source?.disconnect()
    analyser?.disconnect()
    sink?.disconnect()
    if (stream && stream !== activeStream) stream.getTracks().forEach(track => track.stop())
  }
}

export function createMicrophoneManager({ list, assess, switchMic, getCurrentId, isConnected, onRanking }) {
  let assessments = new Map()
  let scanning = null
  let switching = null
  let closed = false

  async function assessMicrophones() {
    if (scanning) return scanning
    scanning = (async () => {
      const results = []
      for (const device of await list()) {
        if (closed) break
        results.push(await assess(device))
      }
      assessments = new Map(results.map(result => [result.deviceId, result]))
      const ranked = rankMicrophones(results, getCurrentId())
      if (!closed) onRanking?.(ranked)
      return ranked
    })().finally(() => { scanning = null })
    return scanning
  }

  function detectMicDisconnect(devices) {
    return !isConnected() || !devices.some(device => device.deviceId === getCurrentId())
  }

  function switchToBestMic({ excludeCurrent = false } = {}) {
    if (switching) return switching
    switching = (async () => {
      const currentId = getCurrentId()
      const devices = await list()
      const ranked = rankMicrophones(devices.map(d => ({ deviceId: d.deviceId, label: d.label, ...assessments.get(d.deviceId) })), currentId)
      for (const device of ranked) {
        if (closed) return false
        if (excludeCurrent && device.deviceId === currentId) continue
        try { await switchMic(device.deviceId); return true } catch { /* next candidate */ }
      }
      return false
    })().finally(() => { switching = null })
    return switching
  }

  return { listMicrophones: list, assessMicrophones, detectMicDisconnect, switchToBestMic,
    close() { closed = true } }
}
