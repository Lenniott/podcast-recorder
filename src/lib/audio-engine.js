/**
 * WebAudio graph + mic resilience: AudioContext/worklet/analyser/gain-node
 * setup, connecting to a specific input device, and automatically falling
 * back through every other device (and finally the browser's own default)
 * if the current mic disappears mid-session. Recording never stops for a
 * device swap — there's a short gap in audio, nothing more.
 *
 * Device-list state (`devices`, `selectedDeviceId`, `micFallback`,
 * `micFallbackName`, `micPermission`) is bound to the page's mic-picker UI,
 * so it has to stay page-local `let`s for Svelte's reactivity to see it —
 * this module reads/writes it through the injected accessors below rather
 * than owning it.
 *
 * GUARDRAIL (see AGENTS.md): silence is written into a take only for a
 * measured, real device gap — never inferred from write latency. This
 * module owns exactly the measurement (micGapStartedAt, tracked against
 * audioCtx.currentTime, the audio graph's own clock); the *decision* to
 * persist a resolved gap as silence stays with the caller, via
 * onDeviceGapResolved — the same separation capture-writer.js's own
 * notifyDeviceGap() requires of everything upstream of it.
 */
export function createAudioEngine({
  onLevel,               // (rms, peak) — raw worklet level message, forwarded as-is
  onChunk,               // (float32Buffer) — raw worklet audio chunk, forwarded as-is
  onDeviceGapResolved,   // (gapSec) — a real, measured device gap just resolved
  onMicConnected,        // () — fires after every successful connect/reconnect
  loadDevices,           // async () => void — refreshes the caller's device list + default selection
  getDevices,            // () => MediaDeviceInfo[]
  getSelectedDeviceId,   // () => string
  setSelectedDeviceId,   // (id) => void
  setMicFallback,        // (bool) => void
  setMicFallbackName,    // (name) => void
  setMicPermissionDenied // () => void — called if even the last-resort getUserMedia fails
}) {
  let audioCtx = null
  let workletNode = null
  let analyserNode = null
  let silentSink = null
  let gainNode = null
  let micSource = null
  let micStream = null
  // Set the instant the current mic stops flowing (device swap/dropout),
  // cleared once audio is flowing again. See the module doc comment above.
  let micGapStartedAt = null

  /**
   * Report a resolved capture gap as real, measured wall-clock silence —
   * the only path allowed to backfill silence into the take. See
   * capture-writer.js for why write-latency must never do this instead.
   */
  function resolveMicGap() {
    if (micGapStartedAt == null) return
    const gapSec = (audioCtx?.currentTime || 0) - micGapStartedAt
    micGapStartedAt = null
    onDeviceGapResolved?.(gapSec)
  }

  /**
   * Connect to a specific device by ID.
   * Uses `ideal` (not `exact`) so the browser can recover if the device
   * is momentarily unavailable rather than hard-throwing.
   * Attaches track.onended so we react the instant the mic is yanked.
   */
  async function connectMic(deviceId, { strictDevice = false } = {}) {
    if (!audioCtx) return

    // Marks the start of a real capture gap unless one is already running
    // (e.g. track.onended already marked it more precisely — see below).
    if (micGapStartedAt == null) micGapStartedAt = audioCtx?.currentTime ?? null

    micSource?.disconnect()
    micStream?.getTracks().forEach(t => t.stop())

    const constraints = {
      audio: {
        // For manual user picks, require that exact device.
        // For automatic reconnect/fallback, allow browser flexibility.
        deviceId: deviceId
          ? (strictDevice ? { exact: deviceId } : { ideal: deviceId })
          : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl:  false,
        channelCount: 1
      }
    }

    micStream = await navigator.mediaDevices.getUserMedia(constraints)

    // Instant detection: fires before devicechange, keeps recording alive.
    // Mark the gap the moment audio actually stops, not once the fallback
    // logic gets around to reacting to it.
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

  /**
   * Mic disappeared. Walk through every available device until one works.
   * Last resort: no deviceId at all (browser picks built-in).
   * Recording never stops — there will be a short gap in audio, nothing more.
   */
  async function connectMicWithFallback() {
    await loadDevices()

    // Try the currently selected device first (it may have just blipped)
    const selectedDeviceId = getSelectedDeviceId()
    const stillAvailable = getDevices().some(d => d.deviceId === selectedDeviceId)
    if (stillAvailable) {
      try {
        await connectMic(selectedDeviceId, { strictDevice: true })
        setMicFallback(false)
        return
      } catch { /* fall through */ }
    }

    // Try each remaining device
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

    // Last resort: let the browser pick (usually the built-in mic)
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

      // Figure out what we actually got
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
    // Keep the worklet graph "live" without sending audible audio to speakers.
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

  function getAnalyserNode() {
    return analyserNode
  }

  /**
   * Discard any gap tracking in flight. The caller uses this right before
   * flipping into 'recording' and creating a fresh Capture Writer — a gap
   * that started before recording did isn't this take's to backfill as
   * silence (there was no writer yet for it to backfill into).
   */
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
    getAnalyserNode,
    clearPendingGap,
    get sampleRate() { return Math.round(audioCtx?.sampleRate || 48000) },
    close
  }
}
