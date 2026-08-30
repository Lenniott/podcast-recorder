/**
 * WebAudio graph + mic resilience: AudioContext/worklet/analyser/gain-node
 * setup, connecting to a specific input device, and automatically falling
 * back if the current mic disappears mid-session.
 *
 * Device-list UI state stays page-local for Svelte reactivity. This module
 * reads/writes it through injected accessors.
 *
 * Guardrail: silence is written only for a measured, real device gap. This
 * module owns the measurement; the caller owns the decision to persist it.
 */
export function createAudioEngine({
  onLevel,
  onChunk,
  onDeviceGapResolved,
  onMicConnected,
  loadDevices,
  getDevices,
  getSelectedDeviceId,
  setSelectedDeviceId,
  setMicFallback,
  setMicFallbackName,
  setMicPermissionDenied
}) {
  let audioCtx = null
  let workletNode = null
  let analyserNode = null
  let silentSink = null
  let gainNode = null
  let micSource = null
  let micStream = null
  let micGapStartedAt = null

  function resolveMicGap() {
    if (micGapStartedAt == null) return
    const gapSec = (audioCtx?.currentTime || 0) - micGapStartedAt
    micGapStartedAt = null
    onDeviceGapResolved?.(gapSec)
  }

  async function connectMic(deviceId, { strictDevice = false } = {}) {
    if (!audioCtx) return

    if (micGapStartedAt == null) micGapStartedAt = audioCtx?.currentTime ?? null

    micSource?.disconnect()
    micStream?.getTracks().forEach(t => t.stop())

    const constraints = {
      audio: {
        deviceId: deviceId
          ? (strictDevice ? { exact: deviceId } : { ideal: deviceId })
          : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1
      }
    }

    micStream = await navigator.mediaDevices.getUserMedia(constraints)
    micStream.getAudioTracks().forEach(track => {
      track.onended = () => {
        micGapStartedAt = audioCtx?.currentTime ?? null
        connectMicWithFallback()
      }
    })

    micSource = audioCtx.createMediaStreamSource(micStream)
    micSource.connect(gainNode)
    gainNode.connect(workletNode)
    gainNode.connect(analyserNode)
    onMicConnected?.()
    resolveMicGap()
  }

  async function connectMicWithFallback() {
    await loadDevices()

    const selectedDeviceId = getSelectedDeviceId()
    const stillAvailable = getDevices().some(d => d.deviceId === selectedDeviceId)
    if (stillAvailable) {
      try {
        await connectMic(selectedDeviceId, { strictDevice: true })
        setMicFallback(false)
        return
      } catch { /* fall through */ }
    }

    for (const device of getDevices()) {
      if (device.deviceId === selectedDeviceId) continue
      try {
        await connectMic(device.deviceId)
        setSelectedDeviceId(device.deviceId)
        setMicFallback(true)
        setMicFallbackName(device.label || 'Unknown microphone')
        return
      } catch { continue }
    }

    try {
      micSource?.disconnect()
      micStream?.getTracks().forEach(t => t.stop())
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 }
      })
      micStream.getAudioTracks().forEach(track => {
        track.onended = () => {
          micGapStartedAt = audioCtx?.currentTime ?? null
          connectMicWithFallback()
        }
      })
      micSource = audioCtx.createMediaStreamSource(micStream)
      micSource.connect(gainNode)
      gainNode.connect(workletNode)
      gainNode.connect(analyserNode)
      onMicConnected?.()
      resolveMicGap()

      await loadDevices()
      const label = micStream.getAudioTracks()[0]?.label || ''
      const match = getDevices().find(d => d.label === label)
      if (match) setSelectedDeviceId(match.deviceId)
      setMicFallback(true)
      setMicFallbackName(label || 'Built-in microphone')
    } catch {
      setMicPermissionDenied()
    }
  }

  async function init() {
    audioCtx = new AudioContext({ sampleRate: 48000 })
    if (audioCtx.state === 'suspended') {
      try { await audioCtx.resume() } catch {}
    }

    await audioCtx.audioWorklet.addModule('/worklet/recorder-processor.js')

    workletNode = new AudioWorkletNode(audioCtx, 'recorder-processor')
    analyserNode = audioCtx.createAnalyser()
    silentSink = audioCtx.createGain()
    silentSink.gain.value = 0
    analyserNode.fftSize = 2048
    gainNode = audioCtx.createGain()
    gainNode.gain.value = 1.0
    workletNode.connect(silentSink)
    silentSink.connect(audioCtx.destination)

    workletNode.port.onmessage = async (e) => {
      if (e.data.type === 'level') onLevel?.(e.data.rms, e.data.peak)
      if (e.data.type === 'data') onChunk?.(e.data.buffer)
    }

    await connectMic(getSelectedDeviceId())
  }

  async function ensureRunning() {
    if (!audioCtx) return
    if (audioCtx.state !== 'running') {
      try { await audioCtx.resume() } catch {}
    }
  }

  function setGain(value) {
    if (gainNode) gainNode.gain.value = value
  }

  function scheduleClapTone(delayMs) {
    setTimeout(() => {
      workletNode?.port.postMessage({ type: 'clap' })
    }, delayMs)
  }

  function postDebugMarker() {
    workletNode?.port.postMessage({ type: 'debug_marker' })
  }

  function clearPendingGap() {
    micGapStartedAt = null
  }

  function close() {
    micStream?.getTracks().forEach(t => t.stop())
    silentSink?.disconnect()
    audioCtx?.close()
  }

  return {
    init,
    changeMic: (deviceId) => connectMic(deviceId, { strictDevice: true }),
    connectMicWithFallback,
    ensureRunning,
    setGain,
    scheduleClapTone,
    postDebugMarker,
    getAnalyserNode: () => analyserNode,
    clearPendingGap,
    get sampleRate() { return Math.round(audioCtx?.sampleRate || 48000) },
    close
  }
}
