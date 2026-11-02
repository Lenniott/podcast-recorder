import { createMicrophoneManager, assessMicrophone, openMicrophone, watchMicrophoneDisconnect } from './microphones.js'

/**
 * WebAudio graph + mic resilience: AudioContext/worklet/analyser/gain-node
 * setup, connecting to a specific input device, and automatically falling
 * back if the current mic disappears mid-session.
 *
 * Device-list UI state stays page-local for Svelte reactivity. This module
 * reads/writes it through injected accessors.
 *
 * The worklet owns continuous samples, including zeros when input is missing.
 */
export function createAudioEngine({
  onLevel,
  onChunk,
  onIssue,
  onMicConnected,
  onMicRanking,
  onAudioState,
  loadDevices,
  getDevices,
  getSelectedDeviceId,
  setSelectedDeviceId,
  setMicFallback,
  setMicFallbackName
}) {
  let audioCtx = null
  let workletNode = null
  let analyserNode = null
  let silentSink = null
  let gainNode = null
  let micSource = null
  let micStream = null
  let recording = false
  let stopRequest = null
  let stopId = 0
  let micConnected = false

  function report(code, message, error) {
    onIssue?.({ code, severity: 'warning', destination: 'capture', message, error })
  }

  let micDeviceId = ''
  let unwatchMic = () => {}
  let switchVersion = 0
  let closed = false
  let microphoneRequest = null
  const microphones = createMicrophoneManager({
    list: async () => { await loadDevices(); return getDevices() },
    assess: device => assessMicrophone(device, { audioContext: audioCtx,
      stream: device.deviceId === micDeviceId ? micStream : undefined }),
    switchMic,
    getCurrentId: () => micDeviceId,
    isConnected: () => micConnected,
    onRanking: ranked => onMicRanking?.(ranked)
  })

  // Detection only reports the event. Both this path and callers use the same switch function.
  function micEnded() {
    micConnected = false
    void requestMicrophone()
  }

  function requestMicrophone() {
    if (micConnected) return Promise.resolve(true)
    if (microphoneRequest) return microphoneRequest
    microphoneRequest = switchToBestMic()
      .catch(error => {
        report('mic-disconnected', 'Microphone reconnect failed.', error)
        return false
      })
      .finally(() => { if (micConnected) microphoneRequest = null })
    return microphoneRequest
  }

  async function switchMic(deviceId) {
    if (!audioCtx || closed) throw new Error('Audio engine is not available')
    const version = ++switchVersion
    // Keep the existing input until its replacement has opened successfully.
    const nextStream = await openMicrophone(deviceId)
    if (closed || version !== switchVersion) {
      nextStream.getTracks().forEach(track => track.stop())
      throw new Error('Microphone switch was superseded')
    }
    let nextSource
    try {
      if (!nextStream.getAudioTracks().length) throw new Error('Microphone has no audio track')
      nextSource = audioCtx.createMediaStreamSource(nextStream)
      nextSource.connect(gainNode)
    } catch (error) {
      nextSource?.disconnect()
      nextStream.getTracks().forEach(track => track.stop())
      throw error
    }
    unwatchMic()
    micSource?.disconnect()
    micStream?.getTracks().forEach(track => track.stop())
    micStream = nextStream
    micSource = nextSource
    const track = micStream.getAudioTracks()[0]
    const settings = track.getSettings?.() ?? {}
    micDeviceId = settings.deviceId || deviceId
    if (settings.echoCancellation || settings.noiseSuppression || settings.autoGainControl) {
      report('mic-processing', 'Browser left audio processing on for the selected microphone.')
    }
    micConnected = true
    microphoneRequest = null
    unwatchMic = watchMicrophoneDisconnect(track, micEnded)
    setSelectedDeviceId(micDeviceId)
    onMicConnected?.()
  }

  async function switchToBestMic(options) {
    const previous = micDeviceId
    const switched = await microphones.switchToBestMic(options)
    if (!switched) {
      report('mic-disconnected', 'No microphone could be connected.')
      return false
    }
    setMicFallback(micDeviceId !== previous)
    setMicFallbackName(micStream.getAudioTracks()[0]?.label || 'Microphone')
    return true
  }

  async function refreshMicrophones() {
    const devices = await microphones.listMicrophones()
    if (microphones.detectMicDisconnect(devices)) await switchToBestMic()
    return microphones.assessMicrophones()
  }

  async function init() {
    audioCtx = new AudioContext({ sampleRate: 48000 })
    // Safari leaves resume() pending until a click, so init must not wait on it.
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {})

    await audioCtx.audioWorklet.addModule('/worklet/recorder-processor.js')

    workletNode = new AudioWorkletNode(audioCtx, 'recorder-processor')
    analyserNode = audioCtx.createAnalyser()
    silentSink = audioCtx.createGain()
    silentSink.gain.value = 0
    analyserNode.fftSize = 2048
    gainNode = audioCtx.createGain()
    gainNode.gain.value = 1.0
    gainNode.connect(workletNode)
    gainNode.connect(analyserNode)
    workletNode.connect(silentSink)
    silentSink.connect(audioCtx.destination)

    audioCtx.onstatechange = () => {
      onAudioState?.(audioCtx.state)
      if (recording && audioCtx.state !== 'running') report('audio-suspended', 'Audio processing stopped; no samples are being captured.')
    }
    onAudioState?.(audioCtx.state)
    workletNode.onprocessorerror = (error) => report('processor-failed', 'Audio processor failed.', error)
    workletNode.port.onmessage = (e) => {
      if (e.data.type === 'level') onLevel?.(e.data.rms, e.data.peak)
      if (e.data.type === 'data' && recording) onChunk?.(e.data.buffer)
      if (e.data.type === 'stopped' && stopRequest?.id === e.data.id) {
        recording = false
        stopRequest.resolve()
      }
    }
    await switchMic(getSelectedDeviceId())
  }

  // Call from a click so Safari allows it. Without one, resume() never
  // settles there, so give up after a moment; startCapture then refuses.
  async function ensureRunning(timeoutMs = 1000) {
    if (!audioCtx || audioCtx.state === 'running' || audioCtx.state === 'closed') return
    let timer
    await Promise.race([
      audioCtx.resume().catch(() => {}),
      new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs) })
    ])
    clearTimeout(timer)
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

  function startCapture() {
    if (!workletNode || audioCtx.state !== 'running') throw new Error('Audio processing is not running')
    recording = true
    workletNode.port.postMessage({ type: 'start' })
  }

  function stopCapture() {
    if (stopRequest) return stopRequest.promise
    if (!recording) return Promise.resolve()
    const id = ++stopId
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        recording = false
        stopRequest = null
        reject(new Error('Audio processor did not acknowledge Stop; the final chunk may be missing'))
      }, 3000)
      stopRequest = { id, resolve: () => { clearTimeout(timer); stopRequest = null; resolve() } }
    })
    stopRequest.promise = promise
    workletNode.port.postMessage({ type: 'stop', id })
    return promise
  }

  function close() {
    closed = true
    switchVersion++
    microphones.close()
    unwatchMic()
    micStream?.getTracks().forEach(t => t.stop())
    silentSink?.disconnect()
    audioCtx?.close()
  }

  return {
    init,
    async changeMic(deviceId) {
      try { await switchMic(deviceId); setMicFallback(false) } catch (error) {
        setSelectedDeviceId(micDeviceId)
        report('mic-disconnected', 'Selected microphone could not be connected.', error)
      }
    },
    switchMic,
    switchToBestMic,
    requestMicrophone,
    refreshMicrophones,
    listMicrophones: microphones.listMicrophones,
    assessMicrophones: microphones.assessMicrophones,
    detectMicDisconnect: microphones.detectMicDisconnect,
    ensureRunning,
    setGain,
    scheduleClapTone,
    postDebugMarker,
    getAnalyserNode: () => analyserNode,
    startCapture,
    stopCapture,
    get micConnected() { return micConnected },
    get sampleRate() { return Math.round(audioCtx?.sampleRate || 48000) },
    close
  }
}
