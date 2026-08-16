<script>
  import { enhance } from '$app/forms'
  import { onMount, onDestroy, tick } from 'svelte'
  import { browser } from '$app/environment'
  import { page } from '$app/stores'
  import { buildWavHeader, float32ToInt16 } from '$lib/audio-utils.js'
  import { METER_MIN, METER_MAX, dbfs, nextFillDb } from '$lib/meter.js'
  import RoomSidebar from '$lib/RoomSidebar.svelte'
  import RoomTabs from '$lib/RoomTabs.svelte'

  function focus(el) { el.focus() }

  export let data   // { slug, roomName, authenticated, participantName, isHostClaim, ... }
  export let form   // action result

  // ─── WebSocket state ────────────────────────────────────────────────
  let ws = null
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
  let bytesWritten = 0
  let dataByteCount = 0        // PCM bytes written (for WAV header patch)
  let recordingSampleRate = 48000
  let recordingStartAudioTime = 0
  let samplesWritten = 0

  // ─── Waveform canvas ────────────────────────────────────────────────
  let canvas
  let canvasCtx
  let animFrame
  let analyserData

  // ─── Clap state ─────────────────────────────────────────────────────
  let lastClapFrom = null
  let clapTimeout = null

  // ─── Clock sync ──────────────────────────────────────────────────────
  // Offset between this client's Date.now() and the server's Date.now().
  // clockOffset = serverTime - clientTime at the same physical moment.
  // Used to correct triggerAtMs (which is in server time) into local time
  // for both clap tone injection and Watch Together playback.
  let clockOffset = 0
  let _clockSamples = []
  let _pingSeq = 0
  const _pendingPings = new Map() // seq → sentAt (client time)

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
  let audioInitError = ''
  /** False once we have a display name from cookie, sessionStorage, or form. */
  let nameGateShow = !data.participantName?.trim()

  // ─── Derived ────────────────────────────────────────────────────────
  $: me = peers.find((p) => p.clientId === clientId)
  $: myRole = me?.role || null
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

    // Instant detection: fires before devicechange, keeps recording alive
    micStream.getAudioTracks().forEach(track => {
      track.onended = () => connectMicWithFallback()
    })

    micSource = audioCtx.createMediaStreamSource(micStream)
    micSource.connect(gainNode)
    gainNode.connect(workletNode)
    gainNode.connect(analyserNode)
    injectReconnectMarker()
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
      micStream.getAudioTracks().forEach(track => { track.onended = () => connectMicWithFallback() })
      micSource = audioCtx.createMediaStreamSource(micStream)
      micSource.connect(gainNode)
      gainNode.connect(workletNode)
      gainNode.connect(analyserNode)
      injectReconnectMarker()

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
    analyserData = new Float32Array(analyserNode.fftSize)
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
      if (e.data.type === 'data' && fileWritable && recordingState === 'recording') {
        const i16 = float32ToInt16(e.data.buffer)
        // Keep timeline continuous across reconnects/device swaps by
        // backfilling missing wall-clock capture time as digital silence.
        const elapsedSec = (audioCtx?.currentTime || 0) - recordingStartAudioTime
        const expectedSamples = Math.max(0, Math.round(elapsedSec * recordingSampleRate))
        const gapSamples = expectedSamples - (samplesWritten + i16.length)
        if (gapSamples > 0) {
          const silence = new Int16Array(gapSamples)
          await fileWritable.write(silence.buffer)
          samplesWritten += gapSamples
          dataByteCount += silence.byteLength
        }
        await fileWritable.write(i16.buffer)
        samplesWritten += i16.length
        dataByteCount += i16.buffer.byteLength
        bytesWritten = dataByteCount + 44
      }
    }

    await connectMic()
    while (pendingClaps.length > 0) {
      const ev = pendingClaps.shift()
      injectClap(ev.from, ev.triggerAtMs)
    }
    startWaveformLoop()
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

  function startWaveformLoop() {
    function draw() {
      animFrame = requestAnimationFrame(draw)
      if (!canvas || !analyserNode) return

      const W = canvas.width
      const H = canvas.height
      canvasCtx.clearRect(0, 0, W, H)

      analyserNode.getFloatTimeDomainData(analyserData)

      // Background
      canvasCtx.fillStyle = '#0e0e10'
      canvasCtx.fillRect(0, 0, W, H)

      // Centre line
      canvasCtx.strokeStyle = '#2a2a2e'
      canvasCtx.lineWidth = 1
      canvasCtx.beginPath()
      canvasCtx.moveTo(0, H / 2)
      canvasCtx.lineTo(W, H / 2)
      canvasCtx.stroke()

      // Waveform
      const isRec = recordingState === 'recording'
      canvasCtx.strokeStyle = isRec ? '#a855f7' : '#52525b'
      canvasCtx.lineWidth = 1.5
      canvasCtx.beginPath()

      const sliceWidth = W / analyserData.length
      let x = 0

      for (let i = 0; i < analyserData.length; i++) {
        const y = (analyserData[i] * 0.5 + 0.5) * H
        if (i === 0) canvasCtx.moveTo(x, y)
        else canvasCtx.lineTo(x, y)
        x += sliceWidth
      }
      canvasCtx.stroke()
    }
    draw()
  }

  // ───────────────────────────────────────────────────────────────────
  // RECORDING
  // ───────────────────────────────────────────────────────────────────

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
    dataByteCount = 0
    samplesWritten = 0
    bytesWritten = 44
    recordingStartAudioTime = audioCtx?.currentTime || 0

    recordingState = 'recording'
    recordingSeconds = 0

    recordingTimer = setInterval(() => recordingSeconds++, 1000)
    wsNotifyState('recording')
  }

  async function stopRecording() {
    if (recordingState !== 'recording') return
    recordingState = 'stopping'
    clearInterval(recordingTimer)
    wsNotifyState('stopped')

    // Give the worklet a moment to flush the last chunk
    await new Promise(r => setTimeout(r, 300))

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
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'clap' }))
    // Server echoes back to all (including sender) which triggers tone injection
  }

  function syncClock() {
    // Ping burst → median RTT/2 estimate of clockOffset (clap + Watch Together).
    _clockSamples = []
    for (let i = 0; i < 3; i++) {
      const seq = ++_pingSeq
      const sentAt = Date.now()
      _pendingPings.set(seq, sentAt)
      ws.send(JSON.stringify({ type: 'ping', seq, sentAt }))
    }
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
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'recording_state', state }))
  }

  function wsSend(payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify(payload))
  }

  const pendingClaps = []

  function connectWs() {
    if (!data.authenticated) return

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    wsStatus = 'connecting'
    ws = new WebSocket(`${proto}//${location.host}/ws?slug=${data.slug}`)

    ws.onopen = () => {
      wsStatus = 'connected'
      ws.send(JSON.stringify({ type: 'join', name: getJoinName(), clientId }))
      try { roomTabs?.resyncDuck?.() } catch {}
      syncClock()
    }

    ws.onmessage = (e) => {
      let msg
      try { msg = JSON.parse(e.data) } catch { return }

      if (msg.type === 'presence')  peers = msg.peers
      if (msg.type === 'pong') {
        const sentAt = _pendingPings.get(msg.seq)
        if (sentAt !== undefined) {
          _pendingPings.delete(msg.seq)
          _clockSamples.push(msg.serverReceivedAt - (sentAt + Date.now()) / 2)
          if (_clockSamples.length >= 3)
            clockOffset = _clockSamples.reduce((a, b) => a + b) / _clockSamples.length
        }
      }
      if (msg.type === 'clap') {
        if (!workletNode) pendingClaps.push({ from: msg.from, triggerAtMs: msg.triggerAtMs })
        else injectClap(msg.from, msg.triggerAtMs)
      }
      if (msg.type === 'tabs_state') roomTabs?.applyTabsState?.(msg)
      if (msg.type === 'tab_video')  roomTabs?.applyTabVideo?.(msg)
      if (msg.type === 'tab_text')   roomTabs?.applyTabText?.(msg)
      if (msg.type === 'yt_duck')    roomTabs?.applyDuck?.(msg)
      if (msg.type === 'error')     console.warn('WS error:', msg.message)
    }

    ws.onclose = () => {
      wsStatus = 'disconnected'
      // Auto-reconnect after 3s (recording continues locally regardless)
      setTimeout(connectWs, 3000)
    }

    ws.onerror = () => {
      wsStatus = 'disconnected'
    }
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
      // Init canvas
      await tick()
      if (canvas) {
        canvasCtx = canvas.getContext('2d')
        canvas.width  = canvas.offsetWidth
        canvas.height = canvas.offsetHeight
      }

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
      myName = (data.participantName || sessionStorage.getItem(participantNameStorageKey) || '').trim()
      if (myName) {
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

  $: if (data.participantName?.trim()) nameGateShow = false

  onDestroy(() => {
    if (!browser) return
    cancelAnimationFrame(animFrame)
    clearInterval(recordingTimer)
    clearTimeout(clapTimeout)
    clearTimeout(peakHoldTimer)
    clearTimeout(clipTimer)
    if (copyLinkTimer) clearTimeout(copyLinkTimer)
    ws?.close()
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
    <p class="sub">Enter the room password to join.</p>

    {#if form?.error}
      <div class="error-banner">{form.error}</div>
    {/if}

    <form method="POST" action="?/enter" use:enhance>
      <div class="field">
        <label for="name">Your name</label>
        <input id="name" name="name" type="text" maxlength="50" bind:value={myName} required />
      </div>
      <div class="field">
        <label for="pw">Password</label>
        <input id="pw" name="password" type="password" use:focus required />
      </div>
      <button type="submit" class="btn-primary">Join Room</button>
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
        <input id="display-name" name="name" type="text" maxlength="50" bind:value={myName} required use:focus />
      </div>
      <button type="submit" class="btn-primary">Continue</button>
    </form>
  </div>
</main>

<!-- ═══════════════════════════════════════════════════════════════ -->
<!-- RECORDING ROOM                                                   -->
<!-- ═══════════════════════════════════════════════════════════════ -->

{:else}
<div class="room">

  <RoomSidebar
    roomName={data.roomName}
    slug={data.slug}
    isHostClaim={data.isHostClaim}
    roomPassword={data.roomPassword}
    {myRole}
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
  .gate-card { max-width: 380px; width: 100%; text-align: center; }
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

  .room-main {
    min-width: 0; /* let the grid column shrink below its content's intrinsic width */
  }

  @media (max-width: 720px) {
    .room {
      grid-template-columns: 1fr;
    }
  }
</style>
