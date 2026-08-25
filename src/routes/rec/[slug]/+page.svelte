<script>
  import { enhance } from '$app/forms'
  import { onMount, onDestroy, tick } from 'svelte'
  import { browser } from '$app/environment'
  import { page } from '$app/stores'
  import { buildWavHeader, float32ToInt16 } from '$lib/audio-utils.js'
  import { createCaptureWriter } from '$lib/capture-writer.js'
  import { createWrittenAudioRing } from '$lib/written-audio-ring.js'
  import { noAutofill } from '$lib/actions.js'
  import { METER_MIN, METER_MAX, dbfs, nextFillDb } from '$lib/meter.js'
  import RoomSidebar from '$lib/RoomSidebar.svelte'
  import RoomTabs from '$lib/RoomTabs.svelte'
  import RecordingCheckModal from '$lib/RecordingCheckModal.svelte'
  import { createRoomConnection } from '$lib/room-connection.js'
  import { createClockSync } from '$lib/clock-sync.js'
  import { createRecordingCheck } from '$lib/recording-check.js'
  import { createWaveformRenderer } from '$lib/waveform-renderer.js'

  function focus(el) { el.focus() }

  export let data   // { slug, roomName, authenticated, participantName, isHostClaim, ... }
  export let form   // action result

  // ─── WebSocket state ────────────────────────────────────────────────
  let wsStatus = 'disconnected' // connected | connecting | disconnected
  let peers = []               // [{ clientId, name, recording, role, isHost }]
  let roomTabs = null          // RoomTabs component instance

  // ─── Mic / device state ─────────────────────────────────────────────
  let devices = []             // MediaDeviceInfo[]
  let selectedDeviceId = ''
  let micPermission = 'prompt' // prompt | granted | denied
  let micFallback = false      // true when we auto-fell-back to a different mic
  let micFallbackName = ''     // label of the fallback device

  // ─── Audio recording state ──────────────────────────────────────────
  let audioCtx = null
  let workletNode = null
  let micSource = null
  let micStream = null
  let analyserNode = null
  let silentSink = null
  let fileWritable = null      // FileSystemWritableFileStream
  let activeFileHandle = null
  let recordingState = 'idle'  // idle | recording | stopping
  let recordingSeconds = 0
  let recordingTimer = null
  let bytesWritten = 0         // display-only running total (updates immediately, not disk-confirmed)
  let recordingSampleRate = 48000
  let captureWriter = null     // owns the WAV byte stream — see $lib/capture-writer.js
  // Set the instant the current mic stops flowing (device swap/dropout),
  // cleared once audio is flowing again. Read by captureWriter.notifyDeviceGap()
  // so silence is only ever written for a REAL gap, never inferred from
  // how long a disk write took (see $lib/capture-writer.js for why that matters).
  let micGapStartedAt = null

  // ─── Waveform canvas ────────────────────────────────────────────────
  // Draw loop + resize live in $lib/waveform-renderer.js; canvas is bound
  // here (RoomSidebar's bind:canvasEl) and read live by the renderer via
  // getCanvas, same for analyserNode/writtenRing/recordingState below.
  let canvas
  // While recording, the waveform draws from this instead of analyserNode —
  // it only ever holds audio the Capture Writer has confirmed was actually
  // written to disk (fed via captureWriter's onWritten). The mic signal can
  // look perfectly healthy while the file silently diverges from it; a
  // display sourced from the mic can never catch that. See
  // $lib/written-audio-ring.js.
  let writtenRing = null

  // ─── Record-start listen-back check ──────────────────────────────────
  // State machine (sentence pick, preview buffer + cap) lives in
  // $lib/recording-check.js; these two stay local reactive mirrors — same
  // reason as clockOffset above, plain reassignment so Svelte tracks it.
  const recordingCheck = createRecordingCheck()
  let checkModalOpen = false
  let checkSentence = ''

  // ─── Clap state ─────────────────────────────────────────────────────
  let lastClapFrom = null
  let clapTimeout = null

  // ─── Clock sync ──────────────────────────────────────────────────────
  // Ping-burst offset estimate (clap tone injection + Watch Together
  // playback), extracted to $lib/clock-sync.js. `send` is bound lazily via
  // the arrow function below — `room` (declared further down) only needs to
  // exist by the time syncClock()/handlePong() are actually called, not at
  // this point in module init.
  const clockSync = createClockSync({ send: (msg) => room.send(msg) })
  // Plain reassignment (not a `$:` derivation) so Svelte's compiler-tracked
  // reactivity actually fires — clockSync.offset is a getter on a plain JS
  // object, invisible to Svelte unless something re-reads it on assignment.
  let clockOffset = 0

  // ─── UI ─────────────────────────────────────────────────────────────
  let myName = ''
  let copyLinkDone = false
  /** @type {ReturnType<typeof setTimeout> | null} */
  let copyLinkTimer = null
  const participantNameStorageKey = browser ? `pr_name_${data.slug}` : ''

  // Browser capability check — File System Access API is Blink only
  // Check for the actual API rather than sniffing the UA string
  const browserSupported = browser ? ('showSaveFilePicker' in window) : true
  // TEMP DEBUG FLAG: append ?debugReconnectMarker=1 while diagnosing mic-switch sync.
  const debugReconnectMarker = browser
    ? new URLSearchParams(window.location.search).get('debugReconnectMarker') === '1'
    : false

  // ─── Stable tab ID ────────────────────────────────────────────────────
  // Stable ID for this browser tab — survives HMR, persists for the session
  // Stored in sessionStorage so a page refresh in the same tab reuses the same ID
  const clientId = browser
    ? (sessionStorage.getItem('pr_clientId') || (() => {
        const id = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
        sessionStorage.setItem('pr_clientId', id)
        return id
      })())
    : null

  // ─── Gain ────────────────────────────────────────────────────────────
  let gainNode    = null
  let gainValue   = 1.0        // linear multiplier (1.0 = 0 dB)

  // ─── dBFS meter ──────────────────────────────────────────────────────
  let dbLevel      = METER_MIN  // current RMS in dBFS (numeric readout)
  /** Smoothed RMS for the green bar — same quantity as the readout, so the
   *  gradient color always matches the numbers. Peak only drives the hold line. */
  let meterFillDb  = METER_MIN
  let lastLevelAt  = 0          // performance.now() of the previous level message
  let peakHoldDb   = METER_MIN  // peak-hold value (resets after 2s)
  let peakHoldTimer = null
  let isClipping   = false      // true for 2s after hitting 0 dBFS
  let clipTimer    = null

  let sessionStarted = false
  let sessionDestroyed = false
  let audioInitError = ''
  let sidebarCollapsed = false // local UI only — never shared over the room WS
  /** False once we have a display name from cookie, sessionStorage, or form. */
  let nameGateShow = !data.participantName?.trim()

  // ─── Derived ────────────────────────────────────────────────────────
  $: myPeerIsRecording = peers.find((p) => p.clientId !== clientId)?.recording ?? false
  $: canRecord = micPermission === 'granted' && recordingState !== 'stopping'
  $: gainDb    = gainValue > 0 ? 20 * Math.log10(gainValue) : -Infinity
  $: meterPct  = Math.max(0, Math.min(100, ((meterFillDb - METER_MIN) / (METER_MAX - METER_MIN)) * 100))
  $: peakPct   = Math.max(0, Math.min(100, ((peakHoldDb - METER_MIN) / (METER_MAX - METER_MIN)) * 100))

  // ───────────────────────────────────────────────────────────────────
  // UTILS
  // ───────────────────────────────────────────────────────────────────

  function formatTime(s) {
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = s % 60
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
    return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
  }

  function formatBytes(b) {
    if (b < 1024) return `${b} B`
    if (b < 1024 * 1024) return `${(b/1024).toFixed(1)} KB`
    return `${(b/1024/1024).toFixed(1)} MB`
  }

  function getJoinName() {
    const n = (myName || '').trim()
    return n || 'Guest'
  }

  function persistParticipantName() {
    if (!browser) return
    const n = (myName || '').trim()
    if (!n) return
    sessionStorage.setItem(participantNameStorageKey, n)
  }

  function copyRoomLink() {
    if (!browser) return
    const url = `${location.origin}/rec/${data.slug}`
    const done = () => {
      copyLinkDone = true
      if (copyLinkTimer) clearTimeout(copyLinkTimer)
      copyLinkTimer = setTimeout(() => { copyLinkDone = false }, 2000)
    }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(done).catch(() => fallbackCopy(url, done))
    } else {
      fallbackCopy(url, done)
    }
  }

  function fallbackCopy(url, onDone) {
    const ta = document.createElement('textarea')
    ta.value = url
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.left = '-9999px'
    document.body.appendChild(ta)
    ta.select()
    try {
      document.execCommand('copy')
      onDone()
    } finally {
      document.body.removeChild(ta)
    }
  }

  // ───────────────────────────────────────────────────────────────────
  // WAV ENCODING
  // ───────────────────────────────────────────────────────────────────

  // ───────────────────────────────────────────────────────────────────
  // MIC / DEVICE
  // ───────────────────────────────────────────────────────────────────

  async function requestMicPermission() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach(t => t.stop())
      micPermission = 'granted'
      await loadDevices()
    } catch (e) {
      micPermission = 'denied'
    }
  }

  async function loadDevices() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices()
      devices = all.filter(d => d.kind === 'audioinput')
      if (!selectedDeviceId && devices.length > 0) {
        selectedDeviceId = devices[0].deviceId
      }
    } catch (e) {
      console.warn('Could not enumerate devices', e)
    }
  }

  /** User manually picked a new mic from the dropdown */
  async function changeMic() {
    micFallback = false
    if (!audioCtx) {
      try {
        await initAudio()
      } catch (err) {
        console.error('Audio init for mic change failed', err)
        return
      }
    }
    await connectMic(selectedDeviceId, { strictDevice: true })
  }

  /**
   * Connect to a specific device by ID.
   * Uses `ideal` (not `exact`) so the browser can recover if the device
   * is momentarily unavailable rather than hard-throwing.
   * Attaches track.onended so we react the instant the mic is yanked.
   */
  async function connectMic(deviceId = selectedDeviceId, { strictDevice = false } = {}) {
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
    injectReconnectMarker()
    resolveMicGap()
  }

  /**
   * Report a resolved capture gap to the Capture Writer as real, measured
   * wall-clock silence — the only path allowed to write silence into the
   * take. See $lib/capture-writer.js for why write-latency must never do this.
   */
  function resolveMicGap() {
    if (micGapStartedAt == null) return
    const gapSec = (audioCtx?.currentTime || 0) - micGapStartedAt
    micGapStartedAt = null
    if (recordingState === 'recording') captureWriter?.notifyDeviceGap(gapSec)
  }

  /**
   * Mic disappeared. Walk through every available device until one works.
   * Last resort: no deviceId at all (browser picks built-in).
   * Recording never stops — there will be a short gap in audio, nothing more.
   */
  async function connectMicWithFallback() {
    await loadDevices()

    // Try the currently selected device first (it may have just blipped)
    const stillAvailable = devices.some(d => d.deviceId === selectedDeviceId)
    if (stillAvailable) {
      try {
        await connectMic(selectedDeviceId, { strictDevice: true })
        micFallback = false
        return
      } catch { /* fall through */ }
    }

    // Try each remaining device
    for (const device of devices) {
      if (device.deviceId === selectedDeviceId) continue
      try {
        await connectMic(device.deviceId)
        selectedDeviceId  = device.deviceId
        micFallback       = true
        micFallbackName   = device.label || 'Unknown microphone'
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
      injectReconnectMarker()
      resolveMicGap()

      // Figure out what we actually got
      await loadDevices()
      const label = micStream.getAudioTracks()[0]?.label || ''
      const match = devices.find(d => d.label === label)
      if (match) selectedDeviceId = match.deviceId
      micFallback     = true
      micFallbackName = label || 'Built-in microphone'
    } catch {
      micPermission = 'denied'
    }
  }

  // ───────────────────────────────────────────────────────────────────
  // AUDIO CONTEXT + WORKLET
  // ───────────────────────────────────────────────────────────────────

  async function initAudio() {
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
    writtenRing = createWrittenAudioRing(analyserNode.fftSize)
    gainNode = audioCtx.createGain()
    gainNode.gain.value = gainValue
    // Keep the worklet graph "live" without sending audible audio to speakers.
    workletNode.connect(silentSink)
    silentSink.connect(audioCtx.destination)

    workletNode.port.onmessage = async (e) => {
      if (e.data.type === 'level') {
        const { rms, peak } = e.data

        // Bar + readout are both RMS; only the hold line shows peak
        dbLevel = dbfs(rms)
        const peakDbNow = dbfs(peak)

        const now = performance.now()
        const dtSec = lastLevelAt ? Math.min(0.25, (now - lastLevelAt) / 1000) : 0.05
        lastLevelAt = now
        meterFillDb = nextFillDb(meterFillDb, dbLevel, dtSec)

        if (peakDbNow > peakHoldDb) {
          peakHoldDb = peakDbNow
          clearTimeout(peakHoldTimer)
          peakHoldTimer = setTimeout(() => { peakHoldDb = METER_MIN }, 2000)
        }

        // Clip detection (peak within 0.5 dB of full scale)
        if (peakDbNow >= -0.5) {
          isClipping = true
          clearTimeout(clipTimer)
          clipTimer = setTimeout(() => { isClipping = false }, 2000)
        }
      }
      if (e.data.type === 'data' && captureWriter && recordingState === 'recording') {
        const i16 = float32ToInt16(e.data.buffer)
        // Queued internally and flushed in the background — a slow disk
        // just makes the queue longer, it can never fabricate silence.
        // Real gaps only ever come from notifyDeviceGap() (see connectMic).
        bytesWritten += captureWriter.writeChunk(i16)
      }
    }

    await connectMic()
    while (pendingClaps.length > 0) {
      const ev = pendingClaps.shift()
      injectClap(ev.from, ev.triggerAtMs)
    }
    waveformRenderer.start()
  }

  async function ensureAudioRunning() {
    if (!audioCtx) return
    if (audioCtx.state !== 'running') {
      try { await audioCtx.resume() } catch {}
    }
  }

  // ───────────────────────────────────────────────────────────────────
  // WAVEFORM VISUALISATION
  // ───────────────────────────────────────────────────────────────────

  const waveformRenderer = createWaveformRenderer({
    getCanvas: () => canvas,
    getAnalyserNode: () => analyserNode,
    getWrittenRing: () => writtenRing,
    isRecording: () => recordingState === 'recording'
  })

  // ───────────────────────────────────────────────────────────────────
  // RECORDING
  // ───────────────────────────────────────────────────────────────────

  /**
   * Fires once per chunk, only after captureWriter has actually confirmed
   * it was written (see capture-writer.js's onWritten). Feeds the live
   * waveform always; feeds the listen-back check's buffer only while that
   * check is open, capped so a host who leaves it open doesn't grow it
   * unbounded.
   */
  function handleWritten(i16) {
    writtenRing?.push(i16)
    recordingCheck.handleWritten(i16)
  }

  function startRecordingCheck() {
    recordingCheck.start()
    checkSentence = recordingCheck.sentence
    checkModalOpen = true
  }

  function buildCheckPreview() {
    return recordingCheck.buildPreview(recordingSampleRate)
  }

  function confirmRecordingCheck() {
    recordingCheck.confirm()
    checkModalOpen = false
  }

  async function rejectRecordingCheck() {
    recordingCheck.reject()
    checkModalOpen = false
    await stopRecording()
  }

  async function startRecording() {
    if (!audioCtx || !workletNode) {
      try {
        await initAudio()
      } catch (err) {
        console.error('Audio init on record failed', err)
        alert('Could not start audio engine. Please refresh and try again.')
        return
      }
    }
    await ensureAudioRunning()
    if (!('showSaveFilePicker' in window)) {
      alert('Your browser does not support the File System Access API.\nPlease use Chrome or Edge.')
      return
    }

    // Prompt user to pick save location
    let fileHandle
    try {
      const safeParticipant = (myName || 'guest').replace(/[^a-z0-9]/gi, '-').toLowerCase()
      const safeName = data.roomName.replace(/[^a-z0-9]/gi, '-').toLowerCase()
      fileHandle = await window.showSaveFilePicker({
        suggestedName: `${safeParticipant}-${safeName}-${new Date().toISOString().slice(0,10)}.wav`,
        types: [{ description: 'WAV Audio File', accept: { 'audio/wav': ['.wav'] } }]
      })
    } catch (e) {
      if (e.name === 'AbortError') return // user cancelled
      alert(`Could not open file: ${e.message}`)
      return
    }

    fileWritable = await fileHandle.createWritable()
    activeFileHandle = fileHandle
    recordingSampleRate = Math.round(audioCtx?.sampleRate || 48000)

    // Write placeholder WAV header (will patch at end with real size)
    await fileWritable.write(buildWavHeader(0, recordingSampleRate))
    bytesWritten = 44
    micGapStartedAt = null // any gap before "recording" started isn't ours to backfill
    captureWriter = createCaptureWriter({
      sampleRate: recordingSampleRate,
      write: (buf) => fileWritable.write(buf),
      onWritten: handleWritten
    })

    recordingState = 'recording'
    recordingSeconds = 0

    recordingTimer = setInterval(() => recordingSeconds++, 1000)
    wsNotifyState('recording')
    startRecordingCheck()
  }

  async function stopRecording() {
    if (recordingState !== 'recording') return
    recordingState = 'stopping'
    clearInterval(recordingTimer)
    wsNotifyState('stopped')

    // Stopping via the regular Stop button while the listen-back check is
    // still up (not via its own "something's wrong" path) should still
    // close it cleanly rather than leave it showing over an idle room.
    if (checkModalOpen) {
      recordingCheck.close()
      checkModalOpen = false
    }

    // Give the worklet a moment to flush its last (sub-BUFFER_SIZE) chunk,
    // then drain every write the Capture Writer has queued — however many
    // there are, not a guessed fixed delay.
    await new Promise(r => setTimeout(r, 300))
    const { dataByteCount } = await captureWriter.stop()
    captureWriter = null

    // Patch the WAV header with the real data size
    await fileWritable.seek(0)
    await fileWritable.write(buildWavHeader(dataByteCount, recordingSampleRate))
    await fileWritable.close()

    activeFileHandle = null
    fileWritable = null
    recordingState = 'idle'
  }

  async function toggleRecording() {
    if (recordingState === 'idle') {
      await startRecording()
    } else if (recordingState === 'recording') {
      await stopRecording()
    }
  }

  // ───────────────────────────────────────────────────────────────────
  // CLAP
  // ───────────────────────────────────────────────────────────────────

  function updateGain() {
    if (gainNode) gainNode.gain.value = gainValue
  }

  function sendClap() {
    room.send({ type: 'clap' })
    // Server echoes back to all (including sender) which triggers tone injection
  }

  function injectClap(from, triggerAtMs = null) {
    const delayMs = Number.isFinite(triggerAtMs)
      ? Math.max(0, triggerAtMs - (Date.now() + clockOffset))
      : 0
    setTimeout(() => {
      workletNode?.port.postMessage({ type: 'clap' })
    }, delayMs)
    lastClapFrom = from
    clearTimeout(clapTimeout)
    clapTimeout = setTimeout(() => lastClapFrom = null, 3000)
  }

  function injectReconnectMarker() {
    if (!debugReconnectMarker) return
    if (recordingState !== 'recording') return
    workletNode?.port.postMessage({ type: 'debug_marker' })
  }

  // ───────────────────────────────────────────────────────────────────
  // WEBSOCKET
  // ───────────────────────────────────────────────────────────────────

  function wsNotifyState(state) {
    room.send({ type: 'recording_state', state })
  }

  function wsSend(payload) {
    room.send(payload)
  }

  const pendingClaps = []

  const room = createRoomConnection({
    createSocket() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
      return new WebSocket(`${proto}//${location.host}/ws?slug=${data.slug}`)
    },
    onOpen() {
      room.send({ type: 'join', name: getJoinName(), clientId })
      clockSync.syncClock()
    },
    onMessage(msg) {
      if (msg.type === 'presence')  peers = msg.peers
      if (msg.type === 'pong') {
        clockSync.handlePong(msg)
        clockOffset = clockSync.offset
      }
      if (msg.type === 'clap') {
        // Flash even when the audio graph isn't up yet (no mic). Queue the
        // tone for when the worklet starts; injectClap does both.
        lastClapFrom = msg.from
        clearTimeout(clapTimeout)
        clapTimeout = setTimeout(() => lastClapFrom = null, 3000)
        if (!workletNode) pendingClaps.push({ from: msg.from, triggerAtMs: msg.triggerAtMs })
        else injectClap(msg.from, msg.triggerAtMs)
      }
      if (msg.type === 'tabs_state') roomTabs?.applyTabsState?.(msg)
      if (msg.type === 'tab_video')  roomTabs?.applyTabVideo?.(msg)
      if (msg.type === 'tab_text')   roomTabs?.applyTabText?.(msg)
      if (msg.type === 'yt_duck')    roomTabs?.applyDuck?.(msg)
      if (msg.type === 'error')     console.warn('WS error:', msg.message)
    },
    onStatusChange(status) {
      wsStatus = status
    }
  })

  room.registerResync(() => {
    roomTabs?.resyncDuck?.()
  })
  room.registerResync(() => {
    if (recordingState === 'recording') wsNotifyState('recording')
  })

  function connectWs() {
    if (sessionDestroyed || !data.authenticated) return
    room.connect()
  }

  // ───────────────────────────────────────────────────────────────────
  // DEVICE CHANGE DETECTION
  // ───────────────────────────────────────────────────────────────────

  function onDeviceChange() {
    // Device list changed — reload and reconnect if our mic disappeared
    connectMicWithFallback().catch(console.error)
  }

  // ───────────────────────────────────────────────────────────────────
  // LIFECYCLE
  // ───────────────────────────────────────────────────────────────────

  async function startSession() {
    if (!browser || !data.authenticated || sessionStarted || nameGateShow) return
    sessionStarted = true
    audioInitError = ''
    try {
      await tick()
      waveformRenderer.resizeCanvas()

      await requestMicPermission()
      if (micPermission === 'granted') {
        try {
          await initAudio()
        } catch (err) {
          console.error('Audio init on join failed', err)
          audioInitError = 'Could not initialize microphone meter. You can still try recording.'
        }
      }

      // Presence/sync should still work even if local audio init fails.
      connectWs()
      navigator.mediaDevices.addEventListener('devicechange', onDeviceChange)
    } catch (err) {
      sessionStarted = false
      console.error('startSession failed', err)
    }
  }

  onMount(async () => {
    if (browser) {
      // Only *restore* a previously-known name — never unconditionally
      // reset myName to '' when neither source has one. This ran
      // unconditionally before, which could race a fast programmatic fill
      // of the name field (e.g. right after the SPA navigation into this
      // route) and silently wipe it out a moment later.
      const known = (data.participantName || sessionStorage.getItem(participantNameStorageKey) || '').trim()
      if (known) {
        myName = known
        nameGateShow = false
        persistParticipantName()
      }
    }
  })

  $: if (data.authenticated && !nameGateShow && !sessionStarted) {
    startSession().catch((err) => {
      console.error('Failed to start session', err)
      sessionStarted = false
    })
  }

  // room-connection.js deliberately doesn't know about auth — its own
  // auto-reconnect loop just keeps retrying on its own schedule, forever,
  // with no way to ask "should I still be doing this?" connectWs()'s guard
  // only covers the first manual connect; if auth is ever invalidated while
  // this component stays mounted (session expiry, not just navigating
  // away), this is what actually stops the loop.
  $: if (browser && sessionStarted && !data.authenticated) {
    room.disconnect()
  }

  // Sidebar collapse changes the canvas's on-screen size — re-run the
  // backing-resolution reset once the DOM has caught up.
  $: if (browser) {
    sidebarCollapsed
    tick().then(() => waveformRenderer.resizeCanvas())
  }

  $: if (data.participantName?.trim()) nameGateShow = false

  onDestroy(() => {
    if (!browser) return
    sessionDestroyed = true
    waveformRenderer.stop()
    clearInterval(recordingTimer)
    clearTimeout(clapTimeout)
    clearTimeout(peakHoldTimer)
    clearTimeout(clipTimer)
    if (copyLinkTimer) clearTimeout(copyLinkTimer)
    room.disconnect()
    micStream?.getTracks().forEach(t => t.stop())
    silentSink?.disconnect()
    audioCtx?.close()
    navigator.mediaDevices?.removeEventListener('devicechange', onDeviceChange)
  })
</script>

<svelte:head>
  <title>{data.roomName} — Podpatch</title>
</svelte:head>

<!-- ═══════════════════════════════════════════════════════════════ -->
<!-- PASSWORD GATE                                                    -->
<!-- ═══════════════════════════════════════════════════════════════ -->

{#if !data.authenticated}
<main class="gate-wrap">
  <div class="card gate-card">
    <div class="gate-icon">🔒</div>
    <h2>{data.roomName}</h2>
    <p class="sub">Enter the room code to join.</p>

    {#if form?.error}
      <div class="error-banner">{form.error}</div>
    {/if}

    <!-- Extensions attach to the first username/password-shaped pair on the
         page. Keep that pair off-screen and *outside* the real form so Chrome
         doesn't treat Join as a login. Real fields stay type=text, unmasked. -->
    <div class="autofill-trap" aria-hidden="true">
      <input type="text" tabindex="-1" autocomplete="username" />
      <input type="password" tabindex="-1" autocomplete="current-password" />
    </div>

    <form
      method="POST"
      action="?/enter"
      autocomplete="off"
      data-1p-ignore
      data-lpignore="true"
      data-bwignore
      data-protonpass-ignore="true"
      use:enhance
    >
      <div class="field">
        <label for="name">Your name</label>
        <input
          id="name"
          name="name"
          type="text"
          autocomplete="off"
          maxlength="50"
          bind:value={myName}
          required
          readonly
          use:noAutofill
          data-1p-ignore
          data-lpignore="true"
          data-bwignore
          data-protonpass-ignore="true"
          data-form-type="other"
        />
      </div>
      <div class="field">
        <label for="room-episode-code">Room code</label>
        <input
          id="room-episode-code"
          name="room-episode-code"
          type="text"
          autocomplete="off"
          spellcheck="false"
          required
          readonly
          use:noAutofill
          data-1p-ignore
          data-lpignore="true"
          data-bwignore
          data-protonpass-ignore="true"
          data-form-type="other"
        />
      </div>
      <button type="submit" class="btn-primary btn-block">Join Room</button>
    </form>
  </div>
</main>

<!-- ═══════════════════════════════════════════════════════════════ -->
<!-- UNSUPPORTED BROWSER                                              -->
<!-- ═══════════════════════════════════════════════════════════════ -->

{:else if !browserSupported}
<main class="gate-wrap">
  <div class="card gate-card browser-card">
    <div class="gate-icon">🚫</div>
    <h2>Browser not supported</h2>
    <p class="sub">
      Recording requires the <strong>File System Access API</strong> to stream
      audio directly to your disk. Your current browser doesn't support it.
    </p>
    <div class="browser-list">
      <div class="browser-item ok">✓ Chrome</div>
      <div class="browser-item ok">✓ Edge</div>
      <div class="browser-item ok">✓ Brave</div>
      <div class="browser-item ok">✓ Opera</div>
      <div class="browser-item bad">✗ Safari</div>
      <div class="browser-item bad">✗ Firefox</div>
      <div class="browser-item bad">✗ DuckDuckGo</div>
    </div>
    <p class="browser-note">
      Open this link in Chrome or Edge and you're good to go.<br/>
      The room URL is: <code>{data.slug}</code>
    </p>
  </div>
</main>

<!-- ═══════════════════════════════════════════════════════════════ -->
<!-- DISPLAY NAME (authenticated but no name cookie yet)             -->
<!-- ═══════════════════════════════════════════════════════════════ -->

{:else if nameGateShow}
<main class="gate-wrap">
  <div class="card gate-card">
    <div class="gate-icon">👤</div>
    <h2>{data.roomName}</h2>
    <p class="sub">How should we show you to others in this room?</p>

    {#if form?.error}
      <div class="error-banner">{form.error}</div>
    {/if}

    <form method="POST" action="?/set_display_name" use:enhance={() => {
      return async ({ update }) => { await update() }
    }}>
      <div class="field">
        <label for="display-name">Your name</label>
        <input id="display-name" name="name" type="text" autocomplete="off" maxlength="50" bind:value={myName} required readonly use:noAutofill use:focus />
      </div>
      <button type="submit" class="btn-primary btn-block">Continue</button>
    </form>
  </div>
</main>

<!-- ═══════════════════════════════════════════════════════════════ -->
<!-- RECORDING ROOM                                                   -->
<!-- ═══════════════════════════════════════════════════════════════ -->

{:else}
<div class="room" class:sidebar-collapsed={sidebarCollapsed}>

  <RoomSidebar
    bind:collapsed={sidebarCollapsed}
    roomName={data.roomName}
    slug={data.slug}
    isHostClaim={data.isHostClaim}
    roomPassword={data.roomPassword}
    {wsStatus}
    {peers}
    {clientId}
    {copyLinkDone}
    onCopyLink={copyRoomLink}
    {devices}
    bind:selectedDeviceId
    {micPermission}
    {audioInitError}
    {micFallback}
    {micFallbackName}
    bind:gainValue
    {gainDb}
    onChangeMic={changeMic}
    onGainInput={updateGain}
    bind:canvasEl={canvas}
    {meterPct}
    {peakPct}
    {dbLevel}
    {peakHoldDb}
    {isClipping}
    {lastClapFrom}
    {recordingState}
    {canRecord}
    {myPeerIsRecording}
    {recordingSeconds}
    {bytesWritten}
    onToggleRecording={toggleRecording}
    onClap={sendClap}
    {formatTime}
    {formatBytes}
  />

  <main class="room-main">
    <!-- Shared tabs: video (per tab) + stacked shared textarea. Implementation
         in RoomTabs.svelte + TabVideoPlayer.svelte + tab-sync.js. -->
    <RoomTabs send={wsSend} {clockOffset} bind:this={roomTabs} />
  </main>

</div>

<RecordingCheckModal
  open={checkModalOpen}
  sentence={checkSentence}
  onListen={buildCheckPreview}
  onConfirm={confirmRecordingCheck}
  onReject={rejectRecordingCheck}
/>
{/if}

<style>
  /* ── Gate ── */
  .gate-wrap {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }
  .gate-card { max-width: 380px; width: 100%; text-align: center; position: relative; }
  .autofill-trap {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  .gate-icon { font-size: 36px; margin-bottom: 12px; }

  .browser-card { max-width: 440px; }
  .browser-list {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
    margin: 16px 0;
    text-align: left;
  }
  .browser-item {
    padding: 7px 12px;
    border-radius: var(--radius);
    font-size: 13px;
    font-weight: 500;
  }
  .browser-item.ok  { background: rgba(34,197,94,.1);  color: #86efac; }
  .browser-item.bad { background: rgba(239,68,68,.08); color: #fca5a5; }
  .browser-note {
    font-size: 12px;
    color: var(--muted);
    line-height: 1.7;
    margin-top: 4px;
  }
  .browser-note code {
    background: var(--border);
    padding: 1px 6px;
    border-radius: 4px;
    font-family: monospace;
    color: var(--text);
  }
  h2 { font-size: 20px; font-weight: 600; margin-bottom: 4px; }
  .sub { color: var(--muted); font-size: 13px; margin-bottom: 20px; }

  .error-banner {
    background: rgba(239,68,68,.12);
    border: 1px solid rgba(239,68,68,.3);
    border-radius: var(--radius);
    color: #fca5a5;
    font-size: 13px;
    padding: 10px 14px;
    margin-bottom: 16px;
    text-align: left;
  }

  /* ── Room layout ── */
  .room {
    min-height: 100vh;
    display: grid;
    grid-template-columns: 240px 1fr;
    gap: 20px;
    max-width: 1400px;
    margin: 0 auto;
    padding: 20px;
    align-items: start;
  }

  .room.sidebar-collapsed {
    grid-template-columns: 72px 1fr;
  }

  .room-main {
    min-width: 0; /* let the grid column shrink below its content's intrinsic width */
  }

  @media (max-width: 720px) {
    .room,
    .room.sidebar-collapsed {
      grid-template-columns: 1fr;
    }
  }
</style>
