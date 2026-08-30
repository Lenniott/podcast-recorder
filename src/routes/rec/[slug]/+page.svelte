<script>
  import { beforeNavigate } from '$app/navigation'
  import { onMount, onDestroy, tick } from 'svelte'
  import { browser } from '$app/environment'
  import { page } from '$app/stores'
  import { buildWavHeader, float32ToInt16 } from '$lib/audio-utils.js'
  import { createCaptureWriter } from '$lib/capture-writer.js'
  import { createWrittenAudioRing } from '$lib/written-audio-ring.js'
  import { METER_MIN, dbToMeterPct } from '$lib/meter.js'
  import RecordingCheckModal from '$lib/RecordingCheckModal.svelte'
  import PasswordGate from '$lib/PasswordGate.svelte'
  import UnsupportedBrowserGate from '$lib/UnsupportedBrowserGate.svelte'
  import DisplayNameGate from '$lib/DisplayNameGate.svelte'
  import RecordingRoom from '$lib/RecordingRoom.svelte'
  import { createRoomConnection } from '$lib/room-connection.js'
  import { createClockSync } from '$lib/clock-sync.js'
  import { createRecordingCheck } from '$lib/recording-check.js'
  import { createWaveformRenderer } from '$lib/waveform-renderer.js'
  import { createAudioEngine } from '$lib/audio-engine.js'
  import { createLevelMeter } from '$lib/level-meter.js'

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
  let audioEngineReady = false
  let fileWritable = null      // FileSystemWritableFileStream
  let activeFileHandle = null
  let recordingState = 'idle'  // idle | recording | stopping
  let recordingSeconds = 0
  let recordingTimer = null
  let bytesWritten = 0         // display-only running total (updates immediately, not disk-confirmed)
  let recordingSampleRate = 48000
  let captureWriter = null     // owns the WAV byte stream — see $lib/capture-writer.js

  // ─── Waveform canvas ────────────────────────────────────────────────
  let canvas
  // The canvas is drawn imperatively (fillStyle/strokeStyle can't reference
  // CSS custom properties directly), so its theme-dependent colors are read
  // from the page's computed style — once up front, then again whenever the
  // theme toggle fires — rather than every animation frame.
  let waveformBg = '#ffffff'
  let waveformCenterLine = '#e0e0e5'
  let waveformStroke = '#6b6b73'
  let waveformStrokeRec = '#0a4e3f'
  function refreshWaveformColors() {
    if (!browser) return
    const cs = getComputedStyle(document.documentElement)
    waveformBg = cs.getPropertyValue('--surface').trim() || waveformBg
    waveformCenterLine = cs.getPropertyValue('--border').trim() || waveformCenterLine
    waveformStroke = cs.getPropertyValue('--muted').trim() || waveformStroke
    waveformStrokeRec = cs.getPropertyValue('--accent').trim() || waveformStrokeRec
  }
  // While recording, the waveform draws from this instead of analyserNode —
  // it only ever holds audio the Capture Writer has confirmed was actually
  // written to disk (fed via captureWriter's onWritten). The mic signal can
  // look perfectly healthy while the file silently diverges from it; a
  // display sourced from the mic can never catch that. See
  // $lib/written-audio-ring.js.
  let writtenRing = null
  const waveformRenderer = createWaveformRenderer({
    getCanvas: () => canvas,
    getAnalyserNode: () => audioEngine.getAnalyserNode(),
    getWrittenRing: () => writtenRing,
    isRecording: () => recordingState === 'recording',
    getColors: () => ({
      bg: waveformBg,
      centerLine: waveformCenterLine,
      stroke: waveformStroke,
      strokeRec: waveformStrokeRec
    })
  })

  // ─── Record-start listen-back check ──────────────────────────────────
  let checkModalOpen = false
  let checkSentence = ''
  const recordingCheck = createRecordingCheck()

  // ─── Clap state ─────────────────────────────────────────────────────
  let lastClapFrom = null
  let clapTimeout = null

  // ─── Clock sync ──────────────────────────────────────────────────────
  // Offset between this client's Date.now() and the server's Date.now().
  // clockOffset = serverTime - clientTime at the same physical moment.
  // Used to correct triggerAtMs (which is in server time) into local time
  // for both clap tone injection and Watch Together playback.
  let clockOffset = 0
  const clockSync = createClockSync({ send: (msg) => room.send(msg) })

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
  let gainValue   = 1.0        // linear multiplier (1.0 = 0 dB)

  // ─── dBFS meter ──────────────────────────────────────────────────────
  let dbLevel      = METER_MIN  // current RMS in dBFS (numeric readout)
  /** Smoothed RMS for the green bar — same quantity as the readout, so the
   *  gradient color always matches the numbers. Peak only drives the hold line. */
  let meterFillDb  = METER_MIN
  let peakHoldDb   = METER_MIN  // peak-hold value (resets after 2s)
  let isClipping   = false      // true for 2s after hitting 0 dBFS
  const levelMeter = createLevelMeter({
    onState(state) {
      dbLevel = state.dbLevel
      meterFillDb = state.meterFillDb
      peakHoldDb = state.peakHoldDb
      isClipping = state.isClipping
    }
  })

  const audioEngine = createAudioEngine({
    onLevel: levelMeter.handleLevel,
    onChunk(buffer) {
      if (!captureWriter || recordingState !== 'recording') return
      const i16 = float32ToInt16(buffer)
      // Queued internally and flushed in the background — a slow disk
      // just makes the queue longer, it can never fabricate silence.
      bytesWritten += captureWriter.writeChunk(i16)
    },
    onDeviceGapResolved(gapSec) {
      if (recordingState === 'recording') captureWriter?.notifyDeviceGap(gapSec)
    },
    onMicConnected() {
      injectReconnectMarker()
    },
    loadDevices,
    getDevices: () => devices,
    getSelectedDeviceId: () => selectedDeviceId,
    setSelectedDeviceId: (id) => { selectedDeviceId = id },
    setMicFallback: (value) => { micFallback = value },
    setMicFallbackName: (name) => { micFallbackName = name },
    setMicPermissionDenied: () => { micPermission = 'denied' }
  })

  let sessionStarted = false
  let sessionDestroyed = false
  let audioInitError = ''
  let sidebarCollapsed = false // local UI only — never shared over the room WS
  let serverCopyUploadState = 'idle' // idle | uploading | catching_up | finalizing | complete | failed
  let allowNextGuardedNavigation = false
  /** False once we have a display name from cookie, sessionStorage, or form. */
  let nameGateShow = !data.participantName?.trim()

  // ─── Derived ────────────────────────────────────────────────────────
  $: myPeerIsRecording = peers.find((p) => p.clientId !== clientId)?.recording ?? false
  $: canRecord = micPermission === 'granted' && recordingState !== 'stopping'
  $: hasIncompleteServerCopyUpload =
    serverCopyUploadState === 'uploading' ||
    serverCopyUploadState === 'catching_up' ||
    serverCopyUploadState === 'finalizing'
  $: hasActiveLocalRecording = recordingState === 'recording' || recordingState === 'stopping'
  $: hasBlockingExitWork = hasActiveLocalRecording || hasIncompleteServerCopyUpload
  $: gainDb    = gainValue > 0 ? 20 * Math.log10(gainValue) : -Infinity
  $: meterPct  = dbToMeterPct(meterFillDb)
  $: peakPct   = dbToMeterPct(peakHoldDb)

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

  function exitWarningMessage() {
    if (hasActiveLocalRecording) {
      return 'Your local recording is still in progress. Leaving now could stop it before the WAV is finalized. Leave anyway?'
    }
    if (hasIncompleteServerCopyUpload) {
      return 'Your recording is saved locally, but the server copy is still uploading. Leave anyway?'
    }
    return ''
  }

  function handleBeforeUnload(event) {
    if (!hasBlockingExitWork) return
    if (allowNextGuardedNavigation) {
      allowNextGuardedNavigation = false
      return
    }
    event.preventDefault()
    // Browsers ignore custom text now, but setting returnValue is still what
    // asks them to show their native leave-site confirmation.
    event.returnValue = ''
    return ''
  }

  function handleDocumentClick(event) {
    if (!hasBlockingExitWork || event.defaultPrevented) return
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return

    const link = event.target?.closest?.('a[href]')
    if (!link || link.target || link.hasAttribute('download')) return

    const url = new URL(link.href, window.location.href)
    if (url.origin !== window.location.origin) return

    if (!window.confirm(exitWarningMessage())) {
      event.preventDefault()
      return
    }

    allowNextGuardedNavigation = true
  }

  if (browser) {
    beforeNavigate((navigation) => {
      if (!hasBlockingExitWork) return

      if (allowNextGuardedNavigation) {
        allowNextGuardedNavigation = false
        return
      }

      if (navigation.willUnload) {
        navigation.cancel()
        return
      }

      if (!window.confirm(exitWarningMessage())) {
        navigation.cancel()
      }
    })
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
    if (!audioEngineReady) {
      try {
        await initAudioEngine()
      } catch (err) {
        console.error('Audio init for mic change failed', err)
        return
      }
    }
    await audioEngine.changeMic(selectedDeviceId)
  }

  /**
   * Mic disappeared. Walk through every available device until one works.
   * Last resort: no deviceId at all (browser picks built-in).
   * Recording never stops — there will be a short gap in audio, nothing more.
   */
  async function connectMicWithFallback() {
    await audioEngine.connectMicWithFallback()
  }

  async function initAudioEngine() {
    await audioEngine.init()
    audioEngineReady = true
    const analyser = audioEngine.getAnalyserNode()
    writtenRing = createWrittenAudioRing(analyser.fftSize)
    audioEngine.setGain(gainValue)
    while (pendingClaps.length > 0) {
      const ev = pendingClaps.shift()
      injectClap(ev.from, ev.triggerAtMs)
    }
    waveformRenderer.start()
  }

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
    checkModalOpen = recordingCheck.open
    checkSentence = recordingCheck.sentence
  }

  function buildCheckPreview() {
    return recordingCheck.buildPreview(recordingSampleRate)
  }

  function confirmRecordingCheck() {
    recordingCheck.confirm()
    checkModalOpen = recordingCheck.open
    checkSentence = recordingCheck.sentence
  }

  async function rejectRecordingCheck() {
    recordingCheck.reject()
    checkModalOpen = recordingCheck.open
    checkSentence = recordingCheck.sentence
    await stopRecording()
  }

  async function startRecording() {
    if (!audioEngineReady) {
      try {
        await initAudioEngine()
      } catch (err) {
        console.error('Audio init on record failed', err)
        alert('Could not start audio engine. Please refresh and try again.')
        return
      }
    }
    await audioEngine.ensureRunning()
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
    recordingSampleRate = audioEngine.sampleRate

    // Write placeholder WAV header (will patch at end with real size)
    await fileWritable.write(buildWavHeader(0, recordingSampleRate))
    bytesWritten = 44
    audioEngine.clearPendingGap() // any gap before "recording" started isn't ours to backfill
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
      checkModalOpen = recordingCheck.open
      checkSentence = recordingCheck.sentence
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
    audioEngine.setGain(gainValue)
  }

  function sendClap() {
    room.send({ type: 'clap' })
    // Server echoes back to all (including sender) which triggers tone injection
  }

  function syncClock() {
    clockSync.syncClock()
  }

  function injectClap(from, triggerAtMs = null) {
    const delayMs = Number.isFinite(triggerAtMs)
      ? Math.max(0, triggerAtMs - (Date.now() + clockOffset))
      : 0
    audioEngine.scheduleClapTone(delayMs)
    lastClapFrom = from
    clearTimeout(clapTimeout)
    clapTimeout = setTimeout(() => lastClapFrom = null, 3000)
  }

  function injectReconnectMarker() {
    if (!debugReconnectMarker) return
    if (recordingState !== 'recording') return
    audioEngine.postDebugMarker()
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
      syncClock()
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
        if (!audioEngineReady) pendingClaps.push({ from: msg.from, triggerAtMs: msg.triggerAtMs })
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
          await initAudioEngine()
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
      window.addEventListener('beforeunload', handleBeforeUnload)
      document.addEventListener('click', handleDocumentClick, { capture: true })
      refreshWaveformColors()
      window.addEventListener('themechange', refreshWaveformColors)

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
    tick().then(waveformRenderer.resizeCanvas)
  }

  $: if (data.participantName?.trim()) nameGateShow = false

  onDestroy(() => {
    if (!browser) return
    sessionDestroyed = true
    waveformRenderer.stop()
    clearInterval(recordingTimer)
    clearTimeout(clapTimeout)
    levelMeter.close()
    if (copyLinkTimer) clearTimeout(copyLinkTimer)
    window.removeEventListener('beforeunload', handleBeforeUnload)
    document.removeEventListener('click', handleDocumentClick, { capture: true })
    window.removeEventListener('themechange', refreshWaveformColors)
    room.disconnect()
    audioEngine.close()
    navigator.mediaDevices?.removeEventListener('devicechange', onDeviceChange)
  })
</script>

<svelte:head>
  <title>{data.roomName} — Podpatch</title>
</svelte:head>

{#if !data.authenticated}
  <PasswordGate roomName={data.roomName} formError={form?.error} bind:myName />
{:else if !browserSupported}
  <UnsupportedBrowserGate slug={data.slug} />
{:else if nameGateShow}
  <DisplayNameGate roomName={data.roomName} formError={form?.error} bind:myName />
{:else}
  <RecordingRoom
    bind:sidebarCollapsed
    bind:roomTabs
    bind:canvasEl={canvas}
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
    send={wsSend}
    {clockOffset}
  />

<RecordingCheckModal
  open={checkModalOpen}
  sentence={checkSentence}
  onListen={buildCheckPreview}
  onConfirm={confirmRecordingCheck}
  onReject={rejectRecordingCheck}
/>
{/if}
