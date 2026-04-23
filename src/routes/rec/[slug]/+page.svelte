<script>
  import { enhance, deserialize } from '$app/forms'
  import { onMount, onDestroy, tick } from 'svelte'
  import { browser } from '$app/environment'
  import { page } from '$app/stores'
  import { buildWavHeader, float32ToInt16 } from '$lib/audio-utils.js'

  function focus(el) { el.focus() }

  export let data   // { slug, roomName, authenticated, participantName, uploadSectionEnabled, isHostClaim, ... }
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

  // ─── Clock sync ──────────────────────────────────────────────────────
  // Offset between this client's Date.now() and the server's Date.now().
  // clockOffset = serverTime - clientTime at the same physical moment.
  // Used to correct triggerAtMs (which is in server time) into local time.
  let clockOffset = 0
  let _clockSamples = []
  let _pingSeq = 0
  const _pendingPings = new Map() // seq → sentAt (client time)

  // ─── UI ─────────────────────────────────────────────────────────────
  let myName = ''
  let micLevel = 0
  let uploadState = 'idle' // idle | ready | uploading | success | error
  let uploadMessage = ''
  let uploadProgress = 0   // 0-100
  let uploadSpeed = 0      // bytes/sec
  let uploadTimeLeft = 0   // seconds
  let uploadLoaded = 0     // bytes
  let uploadTotal = 0      // bytes
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
  const METER_MIN  = -60
  const METER_MAX  =   0
  let dbLevel      = METER_MIN  // current RMS in dBFS (numeric readout)
  /** Smoothed level for the green bar — tracks max(rms, peak) with attack/release */
  let meterFillDb  = METER_MIN
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
  $: isHost = myRole === 'host'
  $: isGuest = myRole === 'guest'
  $: myPeerIsRecording = peers.find((p) => p.clientId !== clientId)?.recording ?? false
  $: recordingLabel = recordingState === 'recording' ? 'Stop Recording' : 'Start Recording'
  $: canRecord = micPermission === 'granted' && recordingState !== 'stopping'
  $: guestUploadReady =
    recordingState === 'idle' && !data.isHostClaim && !!lastRecordingFileHandle
  /** Only guests see the upload card; hosts never upload so hide the section entirely. */
  $: showGuestUploadCard = data.uploadSectionEnabled && !data.isHostClaim
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
        micLevel = rms

        // RMS → dBFS for numeric readout
        dbLevel = rms > 0.00001 ? Math.max(METER_MIN, 20 * Math.log10(rms)) : METER_MIN

        // Peak → dBFS for peak-hold indicator
        const peakDbNow = peak > 0.00001 ? 20 * Math.log10(peak) : METER_MIN
        const target = Math.max(dbLevel, peakDbNow)
        const attack = 0.42
        const release = 0.12
        if (target > meterFillDb) {
          meterFillDb += (target - meterFillDb) * attack
        } else {
          meterFillDb += (target - meterFillDb) * release
        }

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
    if (!data.isHostClaim && lastRecordingFileHandle) {
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

  function fmtBytes(b) {
    if (b >= 1_048_576) return (b / 1_048_576).toFixed(1) + ' MB'
    if (b >= 1024) return (b / 1024).toFixed(0) + ' KB'
    return b + ' B'
  }
  function fmtTime(s) {
    if (!isFinite(s) || s <= 0) return '—'
    if (s >= 3600) return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm'
    if (s >= 60) return Math.floor(s / 60) + 'm ' + Math.floor(s % 60) + 's'
    return Math.ceil(s) + 's'
  }

  async function uploadWavToWebhook(file) {
    if (!file || data.isHostClaim) return
    uploadState = 'uploading'
    uploadMessage = ''
    uploadProgress = 0
    uploadSpeed = 0
    uploadTimeLeft = 0
    uploadLoaded = 0
    uploadTotal = file.size

    const fd = new FormData()
    fd.set('audio_file', file, file.name || 'recording.wav')
    fd.set('client_id', clientId || '')

    await new Promise((resolve) => {
      const xhr = new XMLHttpRequest()
      const startTime = Date.now()

      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return
        const elapsed = (Date.now() - startTime) / 1000
        uploadLoaded = e.loaded
        uploadTotal = e.total
        uploadProgress = Math.round((e.loaded / e.total) * 100)
        uploadSpeed = elapsed > 0 ? e.loaded / elapsed : 0
        uploadTimeLeft = uploadSpeed > 0 ? (e.total - e.loaded) / uploadSpeed : 0
      }

      xhr.onload = () => {
        try {
          const result = deserialize(xhr.responseText)
          const payload = result?.data?.upload
          if (result.type === 'success' && payload?.ok) {
            uploadState = 'success'
            uploadProgress = 100
            uploadMessage = payload.message || 'Successfully sent to Drive workflow.'
          } else {
            uploadState = 'error'
            uploadMessage = payload?.message || 'Upload failed. Please try again.'
          }
        } catch {
          uploadState = 'error'
          uploadMessage = 'Upload failed. Please try again.'
        }
        resolve()
      }

      xhr.onerror = () => {
        uploadState = 'error'
        uploadMessage = 'Upload failed. Please try again.'
        resolve()
      }

      xhr.open('POST', '?/upload_guest_audio')
      xhr.setRequestHeader('accept', 'application/json')
      xhr.send(fd)
    })
  }

  async function uploadLastRecording() {
    if (!guestUploadReady || !lastRecordingFileHandle) return
    const file = await lastRecordingFileHandle.getFile()
    await uploadWavToWebhook(file)
  }

  /** @param {Event} e */
  function onPickWavForUpload(e) {
    const input = e.target
    const file = input instanceof HTMLInputElement && input.files?.[0] ? input.files[0] : null
    if (input instanceof HTMLInputElement) input.value = ''
    if (!file) return
    const lower = file.name.toLowerCase()
    if (!lower.endsWith('.wav')) {
      uploadState = 'error'
      uploadMessage = 'Please choose a WAV file.'
      return
    }
    uploadWavToWebhook(file)
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

  const pendingClaps = []

  function connectWs() {
    if (!data.authenticated) return

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    wsStatus = 'connecting'
    ws = new WebSocket(`${proto}//${location.host}/ws?slug=${data.slug}`)

    ws.onopen = () => {
      wsStatus = 'connected'
      ws.send(JSON.stringify({ type: 'join', name: getJoinName(), clientId }))
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

  <!-- Header -->
  <header>
    <div class="header-left">
      <span class="mic-icon">🎙️</span>
      <div>
        <div class="ep-name">{data.roomName}</div>
        <div class="ep-slug-row">
          <span class="ep-slug">/rec/{data.slug}</span>
          <button type="button" class="btn-copy-link" on:click={copyRoomLink}>
            {copyLinkDone ? 'Copied!' : 'Copy link'}
          </button>
        </div>
        {#if data.isHostClaim && data.roomPassword}
          <div class="room-password-row">
            <span class="room-password-label">Password:</span>
            <span class="room-password-value">{data.roomPassword}</span>
          </div>
        {/if}
        {#if myRole}
          <div class="role-hint" aria-live="polite">
            <span class="role-hint-label">You are</span>
            <span
              class="role-chip role-chip-you"
              class:role-chip-host={myRole === 'host'}
              class:role-chip-guest={myRole === 'guest'}
            >
              {myRole === 'host' ? 'Host' : 'Guest'}
            </span>
          </div>
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
          <div class="peer" class:peer-you={p.clientId === clientId} title={p.name}>
            <span class="peer-name">{p.name}</span>
            <span
              class="role-tag"
              class:role-host={p.role === 'host'}
              class:role-guest={p.role === 'guest'}
              class:role-tag-you={p.clientId === clientId}
            >
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
        <span class="role-pill-guest role-pill-you">Guest uploader</span>
      </div>

      {#if lastRecordingFileHandle || lastRecordingFileName}
        <p class="upload-copy">
          Last saved file: <strong>{lastRecordingFileName || 'Latest recording'}</strong>
        </p>
      {:else}
        <p class="upload-copy">
          Record here and stop to attach your saved WAV, or choose a WAV file below to upload without recording.
        </p>
      {/if}

      <div class="upload-actions">
        <button
          type="button"
          class="btn-primary upload-btn"
          on:click={uploadLastRecording}
          disabled={!guestUploadReady || uploadState === 'uploading'}
        >
          {uploadState === 'uploading' ? 'Uploading…' : 'Upload last recording'}
        </button>
        <label class="btn-secondary upload-pick" class:upload-pick-disabled={uploadState === 'uploading'}>
          <input
            type="file"
            accept=".wav,audio/wav,audio/x-wav,audio/wave"
            class="upload-file-input"
            disabled={uploadState === 'uploading'}
            on:change={onPickWavForUpload}
          />
          Choose WAV…
        </label>
      </div>

      {#if uploadState === 'uploading'}
        <div class="upload-progress-wrap">
          <div class="upload-progress-bar" style="width: {uploadProgress}%"></div>
        </div>
        <div class="upload-progress-stats">
          <span>{uploadProgress}%</span>
          <span>{fmtBytes(uploadLoaded)} / {fmtBytes(uploadTotal)}</span>
          <span>{fmtBytes(uploadSpeed)}/s</span>
          <span>~{fmtTime(uploadTimeLeft)} left</span>
        </div>
      {/if}

      {#if uploadMessage}
        <p class="upload-status" class:upload-ok={uploadState === 'success'} class:upload-error={uploadState === 'error'}>
          {uploadMessage}
        </p>
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
  .ep-slug-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-top: 2px;
  }

  .ep-slug { font-size: 11px; color: var(--muted); font-family: monospace; }

  .room-password-row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 3px;
    font-size: 11px;
  }
  .room-password-label { color: var(--muted); }
  .room-password-value {
    font-family: monospace;
    background: rgba(250,204,21,.12);
    border: 1px solid rgba(250,204,21,.25);
    color: #fde047;
    padding: 2px 7px;
    border-radius: 5px;
    letter-spacing: 0.03em;
  }

  .btn-copy-link {
    font-size: 11px;
    font-weight: 600;
    padding: 4px 10px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    color: var(--text);
    cursor: pointer;
  }

  .btn-copy-link:hover {
    background: var(--border);
  }
  .role-hint {
    margin-top: 6px;
    font-size: 11px;
    color: var(--muted);
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .role-hint-label {
    color: var(--muted);
  }
  .role-chip {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 3px 9px;
    border-radius: 999px;
    border: 1px solid var(--border);
  }
  .role-chip-you.role-chip-host {
    border-color: rgba(168, 85, 247, 0.75);
    color: #f5f3ff;
    background: rgba(168, 85, 247, 0.22);
    box-shadow: 0 0 0 2px rgba(168, 85, 247, 0.35);
  }
  .role-chip-you.role-chip-guest {
    border-color: rgba(34, 197, 94, 0.6);
    color: #dcfce7;
    background: rgba(34, 197, 94, 0.18);
    box-shadow: 0 0 0 2px rgba(34, 197, 94, 0.32);
  }

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
    border: 1px solid transparent;
  }
  .peer.peer-you {
    border-color: rgba(255, 255, 255, 0.14);
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.06);
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
  .role-tag.role-tag-you {
    font-weight: 700;
  }
  .role-tag.role-host.role-tag-you {
    box-shadow: 0 0 0 2px rgba(168, 85, 247, 0.55);
  }
  .role-tag.role-guest.role-tag-you {
    box-shadow: 0 0 0 2px rgba(34, 197, 94, 0.45);
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
    transition: clip-path 0.02s linear;
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
  .role-pill-guest {
    font-size: 11px;
    border-radius: 999px;
    padding: 4px 10px;
    color: #86efac;
    border: 1px solid rgba(34,197,94,.35);
    background: rgba(34,197,94,.1);
  }
  .role-pill-guest.role-pill-you {
    font-weight: 700;
    box-shadow: 0 0 0 2px rgba(34, 197, 94, 0.35);
  }
  .upload-copy {
    font-size: 12px;
    color: var(--muted);
    line-height: 1.6;
  }
  .upload-copy strong { color: var(--text); }
  .upload-actions {
    display: flex;
    align-items: stretch;
    gap: 10px;
    flex-wrap: wrap;
  }
  .upload-btn {
    flex: 1;
    min-width: 140px;
    width: auto;
  }
  .btn-secondary.upload-pick {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    min-width: 140px;
    margin: 0;
    padding: 12px 16px;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text);
    font-weight: 600;
    font-size: 14px;
    cursor: pointer;
    font-family: var(--font);
  }
  .btn-secondary.upload-pick:hover:not(.upload-pick-disabled) {
    background: var(--border);
  }
  .upload-pick-disabled {
    opacity: 0.5;
    pointer-events: none;
  }
  .upload-file-input {
    position: absolute;
    inset: 0;
    opacity: 0;
    cursor: pointer;
    width: 100%;
    height: 100%;
    font-size: 0;
  }
  .upload-status {
    font-size: 12px;
    color: var(--muted);
  }
  .upload-status.upload-ok { color: #86efac; }
  .upload-status.upload-error { color: #fca5a5; }
  .upload-progress-wrap {
    height: 6px;
    background: var(--border);
    border-radius: 999px;
    overflow: hidden;
  }
  .upload-progress-bar {
    height: 100%;
    background: #22c55e;
    border-radius: 999px;
    transition: width 0.3s ease;
  }
  .upload-progress-stats {
    display: flex;
    gap: 12px;
    font-size: 11px;
    color: var(--muted);
    flex-wrap: wrap;
  }

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
