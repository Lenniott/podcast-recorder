<script>
  import { enhance, deserialize } from '$app/forms'
  import { onMount, onDestroy, tick } from 'svelte'
  import { browser } from '$app/environment'
  import { page } from '$app/stores'
  import { buildWavHeader, float32ToInt16, gainToDb, dbToMeterPct } from '$lib/audio-utils.js'

  function focus(el) { el.focus() }

  export let data   // { slug, roomName, authenticated, participantName, createdAt }
  export let form   // action result

  // ─── WebSocket state ────────────────────────────────────────────────
  let ws = null
  let wsStatus = 'disconnected' // connected | connecting | disconnected
  let peers = []               // [{ clientId, name, recording, role, isHost }]

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
  let lastRecordingFileHandle = null
  let lastRecordingFileName = ''
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

  // ─── UI ─────────────────────────────────────────────────────────────
  let myName = ''
  let micLevel = 0
  let uploadState = 'idle' // idle | ready | uploading | success | error
  let uploadMessage = ''
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
  const METER_MIN  = -60
  const METER_MAX  =   0
  let dbLevel      = METER_MIN  // current RMS in dBFS
  let peakHoldDb   = METER_MIN  // peak-hold value (resets after 2s)
  let peakHoldTimer = null
  let isClipping   = false      // true for 2s after hitting 0 dBFS
  let clipTimer    = null
  let sessionStarted = false
  let audioInitError = ''

  // ─── Derived ────────────────────────────────────────────────────────
  $: me = peers.find((p) => p.clientId === clientId)
  $: myRole = me?.role || null
  $: isHost = myRole === 'host'
  $: isGuest = myRole === 'guest'
  $: myPeerIsRecording = peers.find((p) => p.clientId !== clientId)?.recording ?? false
  $: recordingLabel = recordingState === 'recording' ? 'Stop Recording' : 'Start Recording'
  $: canRecord = micPermission === 'granted' && recordingState !== 'stopping'
  $: guestUploadReady = recordingState === 'idle' && isGuest && !!lastRecordingFileHandle
  $: showGuestUploadCard = data.n8nWebhookConfigured && (isGuest || isHost) && (guestUploadReady || uploadState === 'uploading' || uploadState === 'success' || uploadState === 'error')
  $: gainDb    = gainValue > 0 ? 20 * Math.log10(gainValue) : -Infinity
  $: meterPct  = Math.max(0, Math.min(100, ((dbLevel - METER_MIN) / (METER_MAX - METER_MIN)) * 100))
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
        micLevel = rms

        // RMS → dBFS for the meter bar
        dbLevel = rms > 0.00001 ? Math.max(METER_MIN, 20 * Math.log10(rms)) : METER_MIN

        // Peak → dBFS for peak-hold indicator
        const peakDbNow = peak > 0.00001 ? 20 * Math.log10(peak) : METER_MIN
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
    lastRecordingFileHandle = null
    lastRecordingFileName = ''
    uploadState = 'idle'
    uploadMessage = ''
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

    lastRecordingFileHandle = activeFileHandle
    lastRecordingFileName = activeFileHandle?.name || ''
    activeFileHandle = null
    fileWritable = null
    recordingState = 'idle'
    if (isGuest && lastRecordingFileHandle) {
      uploadState = 'ready'
      uploadMessage = 'Recording stopped. Ready to upload to Drive workflow.'
    }
  }

  async function toggleRecording() {
    if (recordingState === 'idle') {
      await startRecording()
    } else if (recordingState === 'recording') {
      await stopRecording()
    }
  }

  async function uploadLastRecording() {
    if (!guestUploadReady || !lastRecordingFileHandle) return
    uploadState = 'uploading'
    uploadMessage = 'Sending to Drive workflow...'
    try {
      const file = await lastRecordingFileHandle.getFile()
      const fd = new FormData()
      fd.set('audio_file', file, file.name || lastRecordingFileName || 'recording.wav')
      fd.set('client_id', clientId || '')

      const response = await fetch('?/upload_guest_audio', {
        method: 'POST',
        body: fd,
        headers: { accept: 'application/json' }
      })
      const result = deserialize(await response.text())
      const payload = result?.data?.upload
      if (result.type === 'success' && payload?.ok) {
        uploadState = 'success'
        uploadMessage = payload.message || 'Successfully sent to Drive workflow.'
        return
      }
      uploadState = 'error'
      uploadMessage = payload?.message || 'Upload failed. Please try again.'
    } catch (err) {
      uploadState = 'error'
      uploadMessage = 'Upload failed. Please try again.'
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

  function injectClap(from, triggerAtMs = null) {
    const delayMs = Number.isFinite(triggerAtMs) ? Math.max(0, triggerAtMs - Date.now()) : 0
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

  const pendingClaps = []

  function connectWs() {
    if (!data.authenticated) return

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    wsStatus = 'connecting'
    ws = new WebSocket(`${proto}//${location.host}/ws?slug=${data.slug}`)

    ws.onopen = () => {
      wsStatus = 'connected'
      ws.send(JSON.stringify({ type: 'join', name: getJoinName(), clientId }))
    }

    ws.onmessage = (e) => {
      let msg
      try { msg = JSON.parse(e.data) } catch { return }

      if (msg.type === 'presence')  peers = msg.peers
      if (msg.type === 'clap') {
        if (!workletNode) pendingClaps.push({ from: msg.from, triggerAtMs: msg.triggerAtMs })
        else injectClap(msg.from, msg.triggerAtMs)
      }
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
    if (!browser || !data.authenticated || sessionStarted) return
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
      if (myName) persistParticipantName()
    }
    await startSession()
  })

  $: if (data.authenticated && !sessionStarted) {
    startSession().catch((err) => {
      console.error('Failed to start session', err)
      sessionStarted = false
    })
  }

  onDestroy(() => {
    if (!browser) return
    cancelAnimationFrame(animFrame)
    clearInterval(recordingTimer)
    clearTimeout(clapTimeout)
    clearTimeout(peakHoldTimer)
    clearTimeout(clipTimer)
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
<!-- RECORDING ROOM                                                   -->
<!-- ═══════════════════════════════════════════════════════════════ -->

{:else}
<div class="room">

  <!-- Header -->
  <header>
    <div class="header-left">
      <span class="mic-icon">🎙️</span>
      <div>
        <div class="ep-name">{data.roomName}</div>
        <div class="ep-slug">/rec/{data.slug}</div>
        {#if myRole}
          <div class="role-hint">You are <strong>{myRole === 'host' ? 'Host' : 'Guest'}</strong></div>
        {/if}
      </div>
    </div>

    <div class="header-right">
      <!-- WS status -->
      <div class="ws-pill" class:ws-ok={wsStatus === 'connected'} class:ws-bad={wsStatus === 'disconnected'}>
        <span class="dot" class:green={wsStatus === 'connected'} class:yellow={wsStatus === 'connecting'} class:grey={wsStatus === 'disconnected'}></span>
        {wsStatus}
      </div>

      <!-- Peer presence -->
      <div class="presence">
        {#each peers as p}
          <div class="peer" title={p.name}>
            <span class="peer-name">{p.name}</span>
            <span class="role-tag" class:role-host={p.role === 'host'} class:role-guest={p.role === 'guest'}>
              {p.role === 'host' ? 'Host' : 'Guest'}
            </span>
            {#if p.recording}
              <span class="rec-dot"></span>
            {/if}
          </div>
        {/each}
        {#if peers.length === 0}
          <span class="muted-text">Waiting for guest…</span>
        {/if}
      </div>
    </div>
  </header>

  <!-- Mic selector -->
  <div class="mic-bar">
    <label for="mic-select">Microphone</label>
    <select id="mic-select" bind:value={selectedDeviceId} on:change={changeMic} disabled={devices.length === 0}>
      {#if devices.length === 0}
        <option value="">No microphone found</option>
      {:else}
        {#each devices as d}
          <option value={d.deviceId}>{d.label || `Microphone ${d.deviceId.slice(0,8)}`}</option>
        {/each}
      {/if}
    </select>

    {#if micPermission === 'denied'}
      <p class="perm-warn">⚠️ Mic access denied. Check browser permissions.</p>
    {/if}
    {#if audioInitError}
      <p class="muted-text">{audioInitError}</p>
    {/if}

    {#if micFallback}
      <p class="fallback-warn">
        ⚠️ Original mic disconnected — switched to <strong>{micFallbackName}</strong>.
        Recording continues. Reconnect your mic or pick a new one above.
      </p>
    {/if}

    <div class="gain-row">
      <label for="gain-slider">
        Input Gain
        <span class="gain-db">{gainDb > 0 ? '+' : ''}{gainDb.toFixed(1)} dB</span>
      </label>
      <input
        id="gain-slider"
        type="range"
        min="0.25"
        max="4"
        step="0.05"
        bind:value={gainValue}
        on:input={updateGain}
      />
      <div class="gain-markers">
        <span>-12</span><span>-6</span><span>0</span><span>+6</span><span>+12</span>
      </div>
    </div>
  </div>

  <!-- Waveform -->
  <div class="waveform-wrap">
    <canvas bind:this={canvas}></canvas>

    <!-- dBFS meter -->
    <div class="db-meter-wrap">
      <div class="db-meter-track">
        <!-- Coloured fill (gradient clipped by width) -->
        <div class="db-meter-fill" style="--meter-pct: {meterPct}%"></div>
        <!-- Peak-hold marker -->
        {#if peakHoldDb > METER_MIN}
          <div class="db-peak-hold" style="left: {peakPct}%"></div>
        {/if}
      </div>
      <!-- dB scale labels -->
      <div class="db-labels">
        <span style="left: 0%">-60</span>
        <span style="left: 60%">-24</span>
        <span style="left: 70%">-18</span>
        <span style="left: 80%">-12</span>
        <span style="left: 90%">-6</span>
        <span style="left: 95%">-3</span>
        <span style="left: 100%">0</span>
      </div>
      <!-- Live readout + clip -->
      <div class="db-readout">
        <span class="db-value">{dbLevel > METER_MIN ? dbLevel.toFixed(1) : '—'} dBFS</span>
        <span class="db-peak-label">pk: {peakHoldDb > METER_MIN ? peakHoldDb.toFixed(1) : '—'}</span>
        {#if isClipping}<span class="clip-badge">CLIP</span>{/if}
      </div>
    </div>

    <!-- Clap flash -->
    {#if lastClapFrom}
      <div class="clap-flash">
        👏 Sync clap — {lastClapFrom}
      </div>
    {/if}
  </div>

  <!-- Controls -->
  <div class="controls">

    <!-- Record button -->
    <button
      class="rec-btn"
      class:recording={recordingState === 'recording'}
      on:click={toggleRecording}
      disabled={!canRecord || micPermission === 'denied'}
      title={micPermission === 'denied' ? 'Mic access required' : ''}
    >
      {#if recordingState === 'idle'}
        <span class="rec-circle"></span> Start Recording
      {:else if recordingState === 'recording'}
        <span class="stop-square"></span> Stop Recording
      {:else}
        Finishing…
      {/if}
    </button>

    <!-- Clap button -->
    <button
      class="clap-btn"
      on:click={sendClap}
      disabled={wsStatus !== 'connected'}
      title="Inject a 1kHz sync tone into both recordings"
    >
      👏 Clap
    </button>

  </div>

  <!-- Stats bar -->
  <div class="stats-bar">
    {#if recordingState === 'recording'}
      <div class="stat recording-stat">
        <span class="stat-dot"></span>
        REC {formatTime(recordingSeconds)}
      </div>
      <div class="stat">{formatBytes(bytesWritten)} written</div>
    {:else if recordingState === 'idle' && bytesWritten > 44}
      <div class="stat">Last recording: {formatBytes(bytesWritten)} saved to your disk</div>
    {/if}

    {#if myPeerIsRecording && recordingState === 'idle'}
      <div class="stat warn-stat">⚠️ Guest is recording — are you?</div>
    {/if}
  </div>

  {#if showGuestUploadCard}
    <div class="upload-card">
      <div class="upload-header">
        <h3>Send recording to Drive</h3>
        {#if isHost}
          <span class="role-pill-host">Host view</span>
        {:else if isGuest}
          <span class="role-pill-guest">Guest uploader</span>
        {/if}
      </div>

      {#if isHost}
        <p class="upload-copy">Host does not upload. The guest (second participant) handles file handoff.</p>
      {:else if guestUploadReady || uploadState === 'uploading' || uploadState === 'success' || uploadState === 'error'}
        <p class="upload-copy">
          Ready file: <strong>{lastRecordingFileName || 'Latest recording'}</strong>
        </p>
        <div class="upload-actions">
          <button class="btn-primary upload-btn" on:click={uploadLastRecording} disabled={!guestUploadReady || uploadState === 'uploading'}>
            {uploadState === 'uploading' ? 'Uploading...' : 'Upload to Drive'}
          </button>
        </div>

        {#if uploadMessage}
          <p class="upload-status" class:upload-ok={uploadState === 'success'} class:upload-error={uploadState === 'error'}>
            {uploadMessage}
          </p>
        {/if}

      {/if}
    </div>
  {/if}

  <!-- Instructions -->
  <div class="instructions">
    <details>
      <summary>How to use</summary>
      <ol>
        <li>Share this URL and the room password with your guest.</li>
        <li>Both of you choose your microphone above.</li>
        <li>Hit <strong>Start Recording</strong> — your browser will ask where to save the WAV file.</li>
        <li>Press <strong>👏 Clap</strong> to inject a sync tone into both recordings. Use this in your editor to line up the tracks.</li>
        <li>When done, hit <strong>Stop Recording</strong>. Guest can optionally upload the WAV to Drive.</li>
      </ol>
      <p class="note">Audio never leaves your computer. The server only carries clap events and presence info.</p>
      <p class="note">If you lose internet, recording continues. Re-connect when back online — just re-load the page.</p>
      <p class="note">File System Access API required — <strong>Chrome or Edge only</strong>.</p>
    </details>
  </div>

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
    display: flex;
    flex-direction: column;
    max-width: 880px;
    margin: 0 auto;
    padding: 20px 20px 40px;
    gap: 16px;
  }

  /* ── Header ── */
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 12px;
    padding: 14px 18px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
  }
  .header-left { display: flex; align-items: center; gap: 12px; }
  .mic-icon { font-size: 24px; }
  .ep-name { font-size: 15px; font-weight: 600; }
  .ep-slug { font-size: 11px; color: var(--muted); font-family: monospace; }
  .role-hint {
    margin-top: 3px;
    font-size: 11px;
    color: var(--muted);
  }
  .role-hint strong { color: var(--text); }

  .header-right { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }

  .ws-pill {
    display: flex; align-items: center; gap: 6px;
    font-size: 12px; color: var(--muted);
    padding: 4px 10px;
    border-radius: 100px;
    border: 1px solid var(--border);
    text-transform: capitalize;
  }

  .presence {
    display: flex; align-items: center; gap: 8px;
    font-size: 13px;
  }
  .peer {
    display: flex; align-items: center; gap: 5px;
    background: var(--border);
    padding: 3px 10px;
    border-radius: 100px;
  }
  .peer-name { font-size: 12px; }
  .role-tag {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: .05em;
    padding: 2px 6px;
    border-radius: 999px;
    border: 1px solid var(--border);
    color: var(--muted);
  }
  .role-tag.role-host {
    border-color: rgba(168,85,247,.45);
    color: #d8b4fe;
    background: rgba(168,85,247,.12);
  }
  .role-tag.role-guest {
    border-color: rgba(34,197,94,.35);
    color: #86efac;
    background: rgba(34,197,94,.1);
  }
  .rec-dot {
    width: 7px; height: 7px;
    background: var(--danger);
    border-radius: 50%;
    animation: blink 1s ease infinite;
  }
  @keyframes blink { 0%,100% { opacity: 1 } 50% { opacity: .3 } }

  .muted-text { color: var(--muted); font-size: 12px; }

  /* ── Mic bar ── */
  .mic-bar {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px 18px;
  }
  .mic-bar label { margin-bottom: 8px; }
  .perm-warn {
    margin-top: 8px;
    font-size: 12px;
    color: var(--warn);
  }
  .fallback-warn {
    margin-top: 8px;
    font-size: 12px;
    color: var(--warn);
    background: rgba(245, 158, 11, .08);
    border: 1px solid rgba(245, 158, 11, .25);
    border-radius: var(--radius);
    padding: 8px 12px;
    line-height: 1.6;
  }
  .fallback-warn strong { color: var(--text); }

  /* ── Waveform ── */
  .waveform-wrap {
    position: relative;
    flex: 1;
    min-height: 160px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
  }
  canvas {
    width: 100%;
    height: 100%;
    display: block;
    min-height: 160px;
  }

  /* ── dBFS Meter ── */
  .db-meter-wrap {
    position: absolute;
    bottom: 10px; left: 12px; right: 12px;
  }

  .db-meter-track {
    position: relative;
    height: 10px;
    background: #1a1a1e;
    border-radius: 3px;
    overflow: visible;
    border: 1px solid var(--border);
  }

  .db-meter-fill {
    width: 100%;
    height: 100%;
    border-radius: 2px;
    /* Gradient spans full track; clip-path reveals current level */
    background: linear-gradient(to right,
      #16a34a   0%,   /* -60 → -24: dark green */
      #22c55e  60%,   /* -24: green */
      #86efac  75%,   /* -12: light green */
      #facc15  82%,   /* -9: yellow */
      #f97316  90%,   /* -6: orange */
      #ef4444  95%,   /* -3: red */
      #dc2626 100%    /*  0: deep red */
    );
    background-size: 100% 100%;
    clip-path: inset(0 calc(100% - var(--meter-pct, 0%)) 0 0);
    transition: clip-path 0.04s linear;
  }

  .db-peak-hold {
    position: absolute;
    top: -2px;
    width: 2px;
    height: calc(100% + 4px);
    background: #fff;
    border-radius: 1px;
    transform: translateX(-50%);
    opacity: 0.9;
  }

  .db-labels {
    position: relative;
    height: 14px;
    margin-top: 3px;
  }
  .db-labels span {
    position: absolute;
    font-size: 9px;
    color: var(--muted);
    transform: translateX(-50%);
    white-space: nowrap;
  }
  /* 0dB label: right-align so it doesn't overflow */
  .db-labels span:last-child { transform: translateX(-100%); }

  .db-readout {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 4px;
  }
  .db-value {
    font-size: 11px;
    font-family: monospace;
    color: var(--text);
    min-width: 80px;
  }
  .db-peak-label {
    font-size: 11px;
    font-family: monospace;
    color: var(--muted);
  }
  .clip-badge {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: .08em;
    background: var(--danger);
    color: #fff;
    padding: 2px 6px;
    border-radius: 3px;
    animation: blink .4s ease infinite;
  }

  /* ── Gain slider ── */
  .gain-row {
    margin-top: 14px;
    border-top: 1px solid var(--border);
    padding-top: 12px;
  }
  .gain-row label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
  }
  .gain-db {
    font-size: 12px;
    font-family: monospace;
    color: var(--accent);
    font-weight: 600;
    text-transform: none;
    letter-spacing: 0;
  }
  .gain-row input[type=range] {
    width: 100%;
    accent-color: var(--accent);
    padding: 0;
    height: 4px;
    border: none;
    background: none;
    cursor: pointer;
  }
  .gain-markers {
    display: flex;
    justify-content: space-between;
    margin-top: 3px;
  }
  .gain-markers span {
    font-size: 9px;
    color: var(--muted);
  }

  .clap-flash {
    position: absolute;
    top: 12px; left: 50%; transform: translateX(-50%);
    background: rgba(168,85,247,.2);
    border: 1px solid var(--accent);
    border-radius: 100px;
    padding: 6px 16px;
    font-size: 13px;
    white-space: nowrap;
    animation: fadeIn .2s ease;
  }
  @keyframes fadeIn { from { opacity: 0; transform: translateX(-50%) translateY(-4px) } to { opacity: 1; transform: translateX(-50%) translateY(0) } }

  /* ── Controls ── */
  .controls {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
  }

  .rec-btn {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 15px;
    font-weight: 600;
    padding: 14px 28px;
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: 10px;
    flex: 1;
    justify-content: center;
    transition: background .15s, border-color .15s;
  }
  .rec-btn:hover:not(:disabled) {
    background: var(--border);
  }
  .rec-btn.recording {
    background: rgba(239,68,68,.12);
    border-color: rgba(239,68,68,.4);
    color: #fca5a5;
  }
  .rec-btn.recording:hover:not(:disabled) {
    background: rgba(239,68,68,.2);
  }

  .rec-circle {
    width: 12px; height: 12px;
    background: var(--danger);
    border-radius: 50%;
    flex-shrink: 0;
  }
  .stop-square {
    width: 12px; height: 12px;
    background: #fca5a5;
    border-radius: 2px;
    flex-shrink: 0;
  }

  .clap-btn {
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--text);
    font-size: 15px;
    padding: 14px 24px;
    border-radius: 10px;
    transition: background .15s;
  }
  .clap-btn:hover:not(:disabled) { background: var(--border); }

  /* ── Stats bar ── */
  .stats-bar {
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
    min-height: 28px;
    align-items: center;
  }
  .stat {
    font-size: 12px;
    color: var(--muted);
  }
  .recording-stat {
    display: flex; align-items: center; gap: 6px;
    color: #fca5a5;
    font-weight: 600;
  }
  .stat-dot {
    width: 8px; height: 8px;
    background: var(--danger);
    border-radius: 50%;
    animation: blink 1s ease infinite;
    flex-shrink: 0;
  }
  .warn-stat { color: var(--warn); }

  /* ── Upload card ── */
  .upload-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px 18px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .upload-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  .upload-header h3 {
    font-size: 15px;
    font-weight: 600;
  }
  .role-pill-host,
  .role-pill-guest {
    font-size: 11px;
    border-radius: 999px;
    padding: 4px 10px;
  }
  .role-pill-host {
    color: #d8b4fe;
    border: 1px solid rgba(168,85,247,.45);
    background: rgba(168,85,247,.12);
  }
  .role-pill-guest {
    color: #86efac;
    border: 1px solid rgba(34,197,94,.35);
    background: rgba(34,197,94,.1);
  }
  .upload-copy {
    font-size: 12px;
    color: var(--muted);
    line-height: 1.6;
  }
  .upload-copy strong { color: var(--text); }
  .upload-actions {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .upload-btn {
    width: auto;
    min-width: 180px;
  }
  .upload-status {
    font-size: 12px;
    color: var(--muted);
  }
  .upload-status.upload-ok { color: #86efac; }
  .upload-status.upload-error { color: #fca5a5; }

  /* ── Instructions ── */
  .instructions {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px 18px;
    font-size: 13px;
  }
  summary {
    cursor: pointer;
    color: var(--muted);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: .05em;
    text-transform: uppercase;
    user-select: none;
  }
  ol {
    margin-top: 12px;
    padding-left: 18px;
    line-height: 2;
    color: var(--text);
  }
  .note {
    margin-top: 10px;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.6;
  }
</style>
