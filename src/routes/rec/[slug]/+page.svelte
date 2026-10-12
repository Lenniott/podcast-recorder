<script>
  import { beforeNavigate } from '$app/navigation'
  import { onMount, onDestroy, tick } from 'svelte'
  import { browser } from '$app/environment'
  import { page } from '$app/stores'
  import { buildWavHeader, float32ToInt16, buildWavBlob } from '$lib/recording/audio-utils.js'
  import { createRecordingSession as createCaptureSession } from '$lib/recording/recording-session.js'
  import { createServerCopyUpload } from '$lib/server-copy/server-copy-upload.js'
  import {
    deriveServerCopyDisplay,
    deriveServerCopyUploadState,
    shouldAnnounceServerCopyFailure
  } from '$lib/server-copy/server-copy-status.js'
  import { deriveExitGuard, isIncompleteServerCopyUpload } from '$lib/recording/exit-guard.js'
  import { createWrittenAudioRing } from '$lib/recording/written-audio-ring.js'
  import { METER_MIN, dbToMeterPct } from '$lib/recording/meter.js'
  import RecordingCheckModal from '$lib/recording/RecordingCheckModal.svelte'
  import PasswordGate from '$lib/PasswordGate.svelte'
  import UnsupportedBrowserGate from '$lib/UnsupportedBrowserGate.svelte'
  import DisplayNameGate from '$lib/DisplayNameGate.svelte'
  import JoinMicStep from '$lib/recording/JoinMicStep.svelte'
  import RecordingRoom from '$lib/recording/RecordingRoom.svelte'
  import LocalCopySavePrompt from '$lib/recording/LocalCopySavePrompt.svelte'
  import {
    JOIN_STEP,
    MIC_DEVICE_KEY,
    afterMicContinue,
    joinStepAfterName,
    micConfirmedKey,
    preferredMicId,
    showsMic
  } from '$lib/recording/join-step.js'
  import {
    createLocalCopyStore,
    localCopySupported,
    localCopyRemoveMessage,
    localCopyWav,
    requestLocalCopyPersistence
  } from '$lib/recording/local-copy-store.js'
  import Model from '$lib/Model.svelte'
  import {
    OTHER_SIDE_UNCERTAIN,
    RECORDING_SESSION_PHASE,
    RECORDING_SESSION_REQUEST_ACTION,
    RECORDING_SESSION_REQUEST_TYPE,
    RECORDING_SESSION_TYPE,
    STOP_BOTH_CONFIRM,
    GUEST_WANTS_START_TITLE,
    GUEST_WANTS_STOP_TITLE,
    HOST_DECLINED_START,
    HOST_DECLINED_STOP,
    createRecordingSession,
    guestWantsStartCopy,
    guestWantsStopCopy
  } from '$lib/recording/synced-recording-session.js'
  import ServerCopyWaitModal from '$lib/server-copy/ServerCopyWaitModal.svelte'
  import { createRoomConnection } from '$lib/room/room-connection.js'
  import { createClockSync } from '$lib/recording/clock-sync.js'
  import {
    countdownSeconds,
    createTakeMarker,
    localTriggerDelayMs,
    TAKE_MARKER_EDGE_END,
    TAKE_MARKER_TYPE
  } from '$lib/recording/take-marker.js'
  import { createCheckTurnCoordinator } from '$lib/recording/check-turn-coordinator.js'
  import {
    encodeInt16PcmBase64,
    decodeInt16PcmBase64,
    CHECK_TURN
  } from '$lib/recording/recording-check-share.js'
  import { createWaveformRenderer } from '$lib/recording/waveform-renderer.js'
  import { createAudioEngine } from '$lib/recording/audio-engine.js'
  import { listMicrophones } from '$lib/recording/microphones.js'
  import { createLevelMeter } from '$lib/recording/level-meter.js'
  import { createTranscriptCapture } from '$lib/room/transcript-capture.js'
  // The two transcript reducers, unchanged (ADR-0002's append-only
  // delivery/ordering is not what ticket 06 touched) — they just run here
  // now that this page owns the lines rather than each child keeping its
  // own listener. See `transcriptLines` below.
  import {
    applyTranscriptState as reduceTranscriptState,
    applyTranscriptLine as reduceTranscriptLine
  } from '$lib/research/research-panel.js'

  export let data   // { slug, roomName, authenticated, participantName, isHostClaim, ... }
  export let form   // action result

  // ─── WebSocket state ────────────────────────────────────────────────
  let wsStatus = 'disconnected' // connected | connecting | disconnected
  let peers = []               // [{ clientId, name, recording, checking, role, isHost, micLabel }]
  let roomTabs = null          // RoomTabs component instance
  let researchPanel = null     // ResearchPanel component instance
  // tabId -> string — RoomTabs.svelte's own true, complete, current copy
  // (both its own just-typed keystrokes and every peer's broadcast
  // tab_text), two-way bound so ResearchPanel can read it directly instead
  // of keeping a second, broadcast-only (and so incomplete for a solo
  // participant) copy of its own. See RoomTabs.svelte's own comment on
  // `export let tabTexts`.
  let tabTexts = {}
  // [{id, speaker, text, at}], in server (append) order — the room's live
  // Transcript. Lifted to this page in ticket 06 (ADR-0008): it used to be
  // tracked twice, once in RoomTabs (which rendered the Transcript Tab) and
  // once in ResearchPanel (which needed the lines as a Placeholder
  // ingredient). Now RoomTabs no longer renders it at all and the panel
  // does, so the common parent holds the one copy and hands it to both —
  // neither child can drift from the other about what was said. Delivery
  // and ordering are untouched; only the owner moved.
  let transcriptLines = []
  // 'annotations' | 'transcript' — which facet of the right-hand panel this
  // participant is looking at. LOCAL UI ONLY, never shared over the room WS,
  // exactly like researchCollapsed below: the Transcript stopped being a
  // room-shared view precisely so one person opening it doesn't move
  // anybody else's screen (see CONTEXT.md's **Transcript**).
  let researchFacet = 'annotations'

  // ─── Mic / device state ─────────────────────────────────────────────
  let devices = []             // MediaDeviceInfo[]
  let selectedDeviceId = ''
  let micPermission = 'prompt' // prompt | granted | denied
  let micFallback = false      // true when we auto-fell-back to a different mic
  let micFallbackName = ''     // label of the fallback device

  // ─── Audio recording state ──────────────────────────────────────────
  let audioEngineReady = false
  let activeLocalCopyName = null // the take this page is still writing; never listed for Save
  let captureTakeName = null   // the take captureSession writes, for the ask on a real stop
  // [{ name, durationSeconds, endedEarly, url }] — this room's unsaved takes in this browser.
  let localCopies = []
  let savePromptName = null
  let lastStoppedName = null
  let recordingState = 'idle'  // idle | recording | stopping
  let recordingSeconds = 0
  let recordingStartedAtMs = null
  let recordingTimer = null
  let bytesWritten = 0         // display-only running total (updates immediately, not disk-confirmed)
  let recordingSampleRate = 48000
  let captureSession = null    // one take's local file + server copy — see recording-session.js
  let rollingAttempt = false   // retake seals the file and leaves capture running
  // Convenience mirror of the local recording — see $lib/server-copy/server-copy-upload.js.
  // The capture session submits each captured chunk here directly. Putting
  // that behind onWritten would let a stalled disk stall the server copy.
  // A failed/slow/rejected upload must never block or delay the local file.
  let serverCopyUpload = null
  let serverCopyTakeId = null
  // What we last told the room about our own server-copy status, so
  // handleServerCopyProgress only sends when the rounded percent/state
  // actually changes (threshold-based, not on every confirmed chunk).
  let lastSentServerCopy = null

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
  // it only ever holds audio the capture session has confirmed was actually
  // written to disk (fed via onWritten). The mic signal can
  // look perfectly healthy while the file silently diverges from it; a
  // display sourced from the mic can never catch that. See
  // $lib/recording/written-audio-ring.js.
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
  let checkTurn = CHECK_TURN.idle
  let bothTurnsPassed = false
  let stayQuietRole = null
  let checkView = {}
  const checkCoordinator = createCheckTurnCoordinator({
    getContext: () => ({ participantId: clientId, role: data.isHostClaim ? 'host' : 'guest',
      peers, connected: wsStatus === 'connected', recording: recordingState === 'recording',
      attemptId: captureTakeName, activeDialog: stopConfirmOpen || guestRequestOpen || awaitingHostAction || savePromptName }),
    send: message => room.send(message),
    rotateAttempt: rotateCheckAttempt,
    requestTakeStart: ({ synced }) => {
      takeMarker.requestStart({ synced })
      if (takeMarker.scheduledTriggerAtMs != null) flashClap(getJoinName())
      startTakeCountdownTick()
    },
    resetTakeMarker: () => resetTakeMarker(),
    onPreviewReady: ({ pcm, sessionId, roundId, attemptId }) => room.send({
      type: 'recording_check_preview', sessionId, roundId, attemptId,
      sampleRate: recordingSampleRate, pcm: encodeInt16PcmBase64(pcm)
    }),
    onChange: view => {
      if (view.sessionId !== checkView.sessionId || view.roundId !== checkView.roundId) clearAllCheckPreviews()
      checkView = view
      checkModalOpen = view.ownCheckVisible
      checkSentence = view.sentence || ''
      checkTurn = view.turn
      bothTurnsPassed = view.complete
      stayQuietRole = view.stayQuietRole
    },
    onIssue: handleRecordingIssue
  })
  // Host-side object URLs of the other peer's listen-back clip, keyed by
  // that peer's clientId. Rebuilt from relayed PCM; never a server-copy file.
  let checkPreviewByClientId = {}

  // ─── Clap / Take Marker state ───────────────────────────────────────
  let lastClapFrom = null
  let clapTimeout = null
  let takeMarker = null
  let takeReady = false
  let takeStartSample = 0
  let takeCountdownSec = 0
  let takeCountdownTimer = null

  function flashClap(from) {
    lastClapFrom = from
    clearTimeout(clapTimeout)
    clapTimeout = setTimeout(() => lastClapFrom = null, 3000)
  }

  /** The marker instant the countdown is counting toward: the tail once one is scheduled, else a pending start. */
  function countdownTarget() {
    if (takeMarker?.scheduledTailTriggerAtMs != null) {
      return { triggerAtMs: takeMarker.scheduledTailTriggerAtMs, offset: takeMarker.scheduledTailOffset }
    }
    if (takeMarker?.scheduledTriggerAtMs != null && !takeMarker.takeReady) {
      return { triggerAtMs: takeMarker.scheduledTriggerAtMs, offset: takeMarker.scheduledOffset }
    }
    return null
  }

  function syncTakeMarkerUi() {
    takeReady = !!takeMarker?.takeReady
    takeStartSample = takeMarker?.startSample ?? 0
    const target = countdownTarget()
    takeCountdownSec = target ? countdownSeconds(target.triggerAtMs, target.offset) : 0
  }

  function startTakeCountdownTick() {
    clearInterval(takeCountdownTimer)
    syncTakeMarkerUi()
    if (!countdownTarget()) {
      takeCountdownTimer = null
      return
    }
    takeCountdownTimer = setInterval(() => {
      syncTakeMarkerUi()
      if (!countdownTarget() || takeCountdownSec === 0) {
        clearInterval(takeCountdownTimer)
        takeCountdownTimer = null
      }
    }, 100)
  }

  function resetTakeMarker() {
    clearInterval(takeCountdownTimer)
    takeCountdownTimer = null
    takeMarker?.reset()
    takeReady = false
    takeStartSample = 0
    takeCountdownSec = 0
  }

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

  // Check for the actual APIs rather than sniffing the UA string.
  const browserSupported = browser ? localCopySupported() : true
  const localCopy = browser && browserSupported ? createLocalCopyStore({ slug: data.slug }) : null
  let joinStep = joinStepAfterName({
    browserSupported,
    micConfirmed: browser && sessionStorage.getItem(micConfirmedKey(data.slug)) === '1'
  })
  // Safari keeps audio suspended until a click on the page; until then the
  // mic is not being captured, and the room says so.
  let audioState = 'running'
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
  /** Smoothed RMS for the green bar. Peak only drives the hold line. */
  let meterFillDb  = METER_MIN
  let peakHoldDb   = METER_MIN  // peak-hold value (resets after 2s)
  let isClipping   = false      // true for 2s after hitting 0 dBFS
  const levelMeter = createLevelMeter({
    onState(state) {
      meterFillDb = state.meterFillDb
      peakHoldDb = state.peakHoldDb
      isClipping = state.isClipping
    }
  })

  const audioEngine = createAudioEngine({
    onLevel: levelMeter.handleLevel,
    onChunk(buffer) {
      if (!captureSession || (recordingState !== 'recording' && recordingState !== 'stopping')) return
      const i16 = float32ToInt16(buffer)
      bytesWritten += captureSession.writeChunk(i16)
    },
    onIssue(issue) {
      if (captureSession) captureSession.reportIssue(issue)
      else handleRecordingIssue(issue)
    },
    onMicRanking(ranked) {
      console.info('[recording] Microphone assessment: signal evidence, not hardware quality')
      console.table(ranked.map((mic, index) => ({ priority: index + 1, label: mic.label,
        deviceId: mic.deviceId, status: mic.status, rms: mic.rms, peak: mic.peak,
        sampleRate: mic.settings?.sampleRate, channels: mic.settings?.channelCount, error: mic.error })))
    },
    onMicConnected() {
      injectReconnectMarker()
    },
    onAudioState(state) {
      audioState = state
    },
    loadDevices,
    getDevices: () => devices,
    getSelectedDeviceId: () => selectedDeviceId,
    setSelectedDeviceId: (id) => { selectedDeviceId = id },
    setMicFallback: (value) => { micFallback = value },
    setMicFallbackName: (name) => { micFallbackName = name }
  })

  let sessionStarted = false
  let sessionDestroyed = false
  let audioInitError = ''
  let sidebarCollapsed = false // local UI only — never shared over the room WS
  let researchCollapsed = false // ditto, for the right-hand Research Assistant panel
  // The clientId-owning capability token (ticket 11), captured off the
  // WS-exclusive 'server_copy_token' reply to our own 'join' — never
  // broadcast, so this is the only place it ever arrives. May still be
  // null if startRecording() runs before this round trip completes;
  // createServerCopyUpload/start() degrade gracefully in that case
  // rather than throwing or hanging (see that module's doc comment).
  let serverCopyToken = null
  let serverCopyUploadState = 'idle' // idle | uploading | catching_up | complete | failed
  // Rounded percent for OUR OWN server-copy upload, kept in lockstep with
  // serverCopyUploadState below — this is what the post-stop blocking modal
  // (ticket 07) shows. Derived via deriveServerCopyDisplay, same as the
  // sidebar (ticket 06), so the two never disagree on what "percent" means.
  let serverCopyUploadPercent = 0
  // Ticket 08: the wait modal only stays open for "still might finish"
  // states (see exit-guard.js's isIncompleteServerCopyUpload) — `failed`
  // isn't one of them, so it closes the instant a copy gives up, same as
  // if it had completed. This flag gates the one-time alert that fills
  // that gap (see the reactive block below) so it fires at most once per
  // take; reset alongside the rest of this take's server-copy state in
  // startRecording().
  let serverCopyFailureAnnounced = false
  let allowNextGuardedNavigation = false
  /** False once we have a display name from cookie, sessionStorage, or form. */
  let nameGateShow = !data.participantName?.trim()

  // ─── Derived ────────────────────────────────────────────────────────
  $: myPeerIsRecording = peers.find((p) => p.clientId !== clientId)?.recording ?? false
  $: canRecord = (roomRecording || micPermission === 'granted') && recordingState !== 'stopping' && !recordingControlBusy
  $: hasIncompleteServerCopyUpload = isIncompleteServerCopyUpload(serverCopyUploadState)
  $: hasActiveLocalRecording = recordingState === 'recording' || recordingState === 'stopping'
  // The post-stop blocking modal (ticket 07): our own recording has fully
  // stopped but our own server copy hasn't reached ticket 05's definition
  // of complete yet. Scoped to this participant only — the sidebar
  // (ticket 06) is the all-participants view. Never in front of the ask
  // to save: Save must not wait on the upload.
  $: showUploadWaitModal = recordingState === 'idle' && hasIncompleteServerCopyUpload && !savePromptTake
  // Ticket 08: fills the gap left by the wait modal above closing silently
  // on failure — see shouldAnnounceServerCopyFailure's doc comment. A
  // plain `$:` block (not something tied only to serverCopyUpload's own
  // onProgress callback) so this still fires when recordingState alone
  // flips to 'idle' after the copy had already failed while still
  // recording, not only when a fresh progress event happens to land after.
  $: if (shouldAnnounceServerCopyFailure({
    recordingState,
    uploadState: serverCopyUploadState,
    announced: serverCopyFailureAnnounced
  })) {
    serverCopyFailureAnnounced = true
    alert(
      "Your server copy could not finish uploading and won't complete. " +
      "Save your recording from this page so you can send that file to the host another way."
    )
  }
  // Single source of truth for exit-guard copy — see $lib/recording/exit-guard.js.
  // Confirm only when blocking; the module still supplies reassurance copy for
  // the complete/idle case so this page never forks those strings.
  $: exitGuard = deriveExitGuard({
    hasActiveLocalRecording,
    hasIncompleteServerCopyUpload,
    serverCopyUploadState
  })
  $: hasBlockingExitWork = exitGuard.blocking
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

  function continueFromMic() {
    void requestLocalCopyPersistence()
    void audioEngine.ensureRunning()
    sessionStorage.setItem(micConfirmedKey(data.slug), '1')
    rememberMic()
    joinStep = afterMicContinue()
  }

  function rememberMic() {
    try { if (selectedDeviceId) localStorage.setItem(MIC_DEVICE_KEY, selectedDeviceId) } catch {}
  }

  // Any click counts as the gesture Safari needs before audio can run.
  function wakeAudio() {
    if (audioState !== 'running') void audioEngine.ensureRunning()
  }

  // ─── Unsaved Local Copies ────────────────────────────────────────────
  // Save is a real <a download> the person clicks: Safari refuses a download
  // started after an await, so each take's URL exists before the click.
  // A revoked URL would break a download still reading it, hence the delay.
  const localCopyUrls = new Map() // `${name}:${size}:${lastModified}` -> object URL
  let localCopyListSeq = 0

  async function refreshLocalCopies() {
    if (!localCopy) return
    const seq = ++localCopyListSeq
    let takes
    try {
      takes = await localCopy.list({
        exclude: activeLocalCopyName ? [activeLocalCopyName] : [],
        onUnreadable: ({ name, error }) => handleRecordingIssue({
          code: 'local-copy-unreadable', severity: 'warning', destination: 'local',
          message: `Could not read ${name} from this browser's storage.`, error
        })
      })
    } catch (error) {
      handleRecordingIssue({ code: 'local-copy-list-failed', severity: 'warning', destination: 'local', message: 'Could not list recordings kept in this browser.', error })
      return
    }
    if (seq !== localCopyListSeq) return
    const kept = new Set()
    localCopies = takes.map((take) => {
      const key = `${take.name}:${take.dataBytes}:${take.lastModified}`
      if (!localCopyUrls.has(key)) localCopyUrls.set(key, URL.createObjectURL(localCopyWav(take, take.file)))
      kept.add(key)
      return { name: take.name, durationSeconds: take.durationSeconds, endedEarly: take.endedEarly, url: localCopyUrls.get(key) }
    })
    for (const [key, url] of localCopyUrls) {
      if (kept.has(key)) continue
      localCopyUrls.delete(key)
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    }
  }

  // Runs from the Save link's own click. The browser has been handed the
  // WAV but has not necessarily finished writing it to Downloads.
  // So nothing is deleted on the strength of a click alone: removal waits for
  // the person to confirm, after they've seen the saved file open.
  let savedLocalCopyNames = new Set()

  function onLocalCopySaveClick(take) {
    if (savePromptName === take.name) savePromptName = null
    savedLocalCopyNames = new Set(savedLocalCopyNames).add(take.name)
  }

  async function onLocalCopyRemoveClick(take) {
    if (!confirm(localCopyRemoveMessage(take, savedLocalCopyNames.has(take.name)))) return
    try {
      await localCopy.remove(take.name)
    } catch (error) {
      handleRecordingIssue({ code: 'local-copy-remove-failed', severity: 'warning', destination: 'local', message: `Could not remove ${take.name} from this browser.`, error })
    }
    if (lastStoppedName === take.name) lastStoppedName = null
    await refreshLocalCopies()
  }

  $: savePromptTake = localCopies.find((take) => take.name === savePromptName) ?? null
  $: lastStoppedTake = localCopies.find((take) => take.name === lastStoppedName) ?? null

  function persistParticipantName() {
    if (!browser) return
    const n = (myName || '').trim()
    if (!n) return
    sessionStorage.setItem(participantNameStorageKey, n)
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

    if (!window.confirm(exitGuard.message)) {
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

      if (!window.confirm(exitGuard.message)) {
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
      devices = await listMicrophones()
      if (!selectedDeviceId && devices.length > 0) {
        let savedId = null
        try { savedId = localStorage.getItem(MIC_DEVICE_KEY) } catch {}
        selectedDeviceId = preferredMicId(devices, savedId)
      }
    } catch (e) {
      console.warn('Could not enumerate devices', e)
    }
  }

  /** User manually picked a new mic from the dropdown */
  async function changeMic() {
    micFallback = false
    rememberMic()
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

  // Re-measure, then leave the current device if another one is actually sending audio.
  async function switchToBestMic(options = { excludeCurrent: true }) {
    const ranked = await audioEngine.assessMicrophones()
    const skipCurrent = options.excludeCurrent !== false
    const live = ranked.some(device => device.status === 'signal' && (!skipCurrent || device.deviceId !== selectedDeviceId))
    if (!live) {
      captureSession?.reportIssue({ code: 'no-signal', severity: 'warning', destination: 'capture', message: 'No microphone is sending a signal.' })
      return false
    }
    return audioEngine.switchToBestMic(options)
  }

  async function initAudioEngine() {
    await audioEngine.init()
    audioEngineReady = true
    void audioEngine.assessMicrophones().catch(error => handleRecordingIssue({ code: 'mic-assessment-failed', severity: 'warning', destination: 'capture', message: 'Could not assess microphones.', error }))
    const analyser = audioEngine.getAnalyserNode()
    writtenRing = createWrittenAudioRing(analyser.fftSize)
    audioEngine.setGain(gainValue)
    while (pendingClaps.length > 0) {
      const ev = pendingClaps.shift()
      injectClap(ev.from, ev.triggerAtMs)
    }
    takeMarker?.onEngineReady()
    waveformRenderer.start()
  }

  // ───────────────────────────────────────────────────────────────────
  // RECORDING
  // ───────────────────────────────────────────────────────────────────

  // Voice Trigger capture (ticket 03; see $lib/room/transcript-capture.js and
  // ADR-0003) — starts/stops exactly with our own local recording, no
  // separate button, no separate consent step. `send` closes over `room`,
  // defined further below (safe: never invoked before the component's
  // synchronous setup — which assigns `room` — has finished running).
  // Every failure path inside transcriptCapture is already swallowed by
  // that module, so nothing here needs its own try/catch to protect
  // startRecording/stopRecording's own critical sections.
  // Per-browser, never sent over the WS — see RoomTabs.svelte's own prop
  // doc comment. Drives the small status dot on the Transcript pill so a
  // silently-dead recognizer (the bug speech-recognition.js's retry logic
  // now recovers from on its own) is still visible in the meantime, not
  // indistinguishable from "everything's fine."
  let transcriptionStatus = 'stopped'

  const transcriptCapture = createTranscriptCapture({
    send: (msg) => room.send(msg),
    getSpeakerName: () => getJoinName(),
    onStatusChange: (status) => { transcriptionStatus = status }
  })

  /**
   * Fires once per chunk, only after the capture session has confirmed the
   * local write (see capture-writer.js's onWritten). Feeds the waveform and,
   * while a check is open, the listen-back buffer.
   */
  function handleWritten(i16, attemptId) {
    writtenRing?.push(i16)
    checkCoordinator.handleWritten(i16, { attemptId })
  }

  /**
   * The server-copy upload's onProgress callback. Derives the small
   * display-ready {state, percent} shape (see $lib/server-copy/server-copy-status.js)
   * once, and, only when it actually changed, tells the room about it —
   * the same threshold-based, percentage-only broadcast recording_state
   * uses for local recording. Both peers then read the identical value
   * back off `peers` via the room's own presence broadcast (see
   * ws-rooms.js).
   */
  function handleServerCopyProgress(status) {
    // Shared vocabulary from $lib/server-copy/server-copy-status.js — distinguishes
    // "still uploading while we're still recording" from "recording
    // stopped locally, upload still catching up" so both the exit-guard
    // warning text and the post-stop blocking modal (ticket 07) stay
    // accurate. isRecording is the one thing the status object alone can't
    // tell it.
    serverCopyUploadState = deriveServerCopyUploadState(status, { isRecording: recordingState === 'recording' })
    const display = deriveServerCopyDisplay(status)
    serverCopyUploadPercent = display.percent
    sendServerCopyProgress(display)
  }

  function startServerCopyUploadWhenReady() {
    if (!serverCopyUpload || !serverCopyToken) return
    serverCopyUpload.setToken(serverCopyToken)
    serverCopyUpload.start() // fire-and-forget — never gates local recording, see module doc
  }

  // Takes the already-derived {state, percent} display shape (see
  // $lib/server-copy/server-copy-status.js's deriveServerCopyDisplay) rather than a raw
  // upload status, so every caller derives it exactly once — callers that
  // don't already have a display value in hand (the reset below, the
  // resync below) derive it themselves at the call site.
  function sendServerCopyProgress(display, { force = false } = {}) {
    const { state, percent } = display
    if (!force && lastSentServerCopy?.state === state && lastSentServerCopy?.percent === percent) return
    lastSentServerCopy = { state, percent }
    room.send({ type: 'server_copy_progress', state, percent, takeId: serverCopyTakeId })
  }

  function makeServerCopyTakeId() {
    return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
  }

  function applyCheckPreview(msg) {
    if (!checkCoordinator.acceptsPreview(msg)) return
    const pcm = decodeInt16PcmBase64(msg.pcm)
    const id = String(msg.clientId || '')
    const sampleRate = Number(msg.sampleRate)
    if (!pcm || !id || !Number.isFinite(sampleRate)) return
    const blob = buildWavBlob([pcm], sampleRate)
    const prev = checkPreviewByClientId[id]
    if (prev) URL.revokeObjectURL(prev)
    checkPreviewByClientId = { ...checkPreviewByClientId, [id]: URL.createObjectURL(blob) }
  }

  function pruneCheckPreviews(nextPeers) {
    const keep = new Set(
      nextPeers.filter((p) => p.recording).map((p) => p.clientId)
    )
    const next = {}
    let changed = false
    for (const [id, url] of Object.entries(checkPreviewByClientId)) {
      if (keep.has(id)) next[id] = url
      else {
        URL.revokeObjectURL(url)
        changed = true
      }
    }
    if (changed) checkPreviewByClientId = next
  }

  function clearAllCheckPreviews() {
    for (const url of Object.values(checkPreviewByClientId)) URL.revokeObjectURL(url)
    checkPreviewByClientId = {}
  }

  function buildCheckPreview() { return checkCoordinator.buildPreview(recordingSampleRate) }
  function confirmRecordingCheck() { checkCoordinator.confirm() }
  function rejectRecordingCheck() { checkCoordinator.reject() }

  // Serialises a retake roll with stopRecording so Stop never finalizes a
  // writer the roll is already closing.
  let attemptRoll = Promise.resolve(true)

  /**
   * A rejected Check Turn: the current attempt's WAV is finalized and left
   * on disk, the next attempt opens in the same folder, and the check
   * sequence starts again on that file. Recording state stays 'recording'
   * throughout, so peers never see a stop/start flicker.
   */
  async function rotateCheckAttempt({ signal }) {
    const previousRoll = attemptRoll
    const roll = (async () => {
      await previousRoll.catch(() => {})
      if (signal.aborted || recordingState !== 'recording') return false
      const session = captureSession
      rollingAttempt = true
      const pending = session?.stop({ capture: false })
      try {
        if (session) {
          await session.whenLocalFinished
          if (captureSession === session) {
            captureSession = null
            captureTakeName = null
          }
        }
        if (signal.aborted) return false
        return await openNextAttempt({ signal })
      } finally {
        rollingAttempt = false
        void pending?.catch(error => handleRecordingIssue({
          code: 'save-failed', severity: 'error', destination: 'server',
          message: 'Server recording could not be saved.', error
        }))
      }
    })()
    attemptRoll = roll
    const ready = await roll
    if (signal.aborted) return { status: 'cancelled' }
    if (!ready) {
      await recordingSession.onLocalFailure()
      return { status: 'failed', error: new Error('Could not open the next attempt') }
    }
    if (recordingState !== 'recording') return { status: 'cancelled' }
    wsNotifyState('recording')
    return { status: 'ready', attemptId: captureTakeName }
  }

  // UI can consume this same issue object later. Saving never depends on it.
  function handleRecordingIssue(issue) {
    const log = issue.severity === 'error' ? console.error : console.warn
    log('[recording]', issue)
  }

  async function startRecording({ signal } = {}) {
    if (signal?.aborted) return
    if (!audioEngineReady) {
      try {
        await initAudioEngine()
      } catch (err) {
        console.error('Audio init on record failed', err)
        alert('Could not start audio engine. Please refresh and try again.')
        return
      }
    }
    if (signal) {
      let cancel
      try {
        await Promise.race([
          audioEngine.ensureRunning(),
          new Promise(resolve => {
            cancel = resolve
            signal.addEventListener('abort', cancel, { once: true })
            if (signal.aborted) resolve()
          })
        ])
      } finally { signal.removeEventListener('abort', cancel) }
    } else await audioEngine.ensureRunning()
    if (signal?.aborted) return

    if (!(await openNextAttempt({ signal }))) return
    if (signal?.aborted) {
      // Keep the newly opened attempt, even when it contains only its header.
      const session = captureSession
      if (session) await session.stop({ capture: false })
      if (captureSession === session) { captureSession = null; captureTakeName = null }
      return
    }

    try {
      audioEngine.startCapture()
    } catch (error) {
      handleRecordingIssue({ code: 'capture-start-failed', severity: 'error', destination: 'capture', message: 'Could not start audio capture.', error })
      const session = captureSession
      if (session) await session.stop()
      if (captureSession === session) {
        captureSession = null
        captureTakeName = null
      }
      return
    }

    recordingState = 'recording'
    recordingTimer = setInterval(() => recordingSeconds++, 1000)
    wsNotifyState('recording')
    checkCoordinator.start()
    // Last: purely additive, and transcriptCapture never throws (see its
    // own doc comment) — placed after every write-path-critical step above
    // has already completed.
    transcriptCapture.start()
  }

  /**
   * Opens the next Local Copy attempt in this browser's storage and points
   * the capture writer, server copy, and Take Marker at it. Shared by
   * startRecording and a retake roll so both write through one path.
   */
  async function openNextAttempt({ signal } = {}) {
    let attempt
    try {
      attempt = await localCopy.openNext({
        participantName: getJoinName(),
        roomName: data.roomName
      })
      recordingSampleRate = audioEngine.sampleRate
      // Placeholder header, patched with the real size when the take closes.
      // A take that never closes keeps it, which is how it reads as ended early.
      await attempt.file.write(buildWavHeader(0, recordingSampleRate))
    } catch (e) {
      if (attempt) void Promise.resolve(attempt.file.abort()).catch(() => {})
      handleRecordingIssue({ code: 'local-open-failed', severity: 'error', destination: 'local',
        message: 'Could not open the local recording attempt.', error: e })
      return false
    }
    if (signal?.aborted || sessionDestroyed) {
      await attempt.file.close()
      void refreshLocalCopies()
      return false
    }
    const writable = attempt.file
    const takeName = attempt.name
    activeLocalCopyName = takeName
    bytesWritten = 44

    // Fresh take, fresh server-copy session — reset any status left over
    // from a previous take before this one has told the server anything,
    // so peers never see a stale "complete"/"failed" pill for a take that
    // hasn't started yet.
    lastSentServerCopy = null
    serverCopyTakeId = makeServerCopyTakeId()
    serverCopyUploadState = 'idle'
    serverCopyUploadPercent = 0
    serverCopyFailureAnnounced = false
    sendServerCopyProgress(deriveServerCopyDisplay(null), { force: true })
    // A rejected attempt's upload keeps finishing in the background; only
    // the current attempt's upload may drive this take's status.
    let session
    const upload = createServerCopyUpload({
      slug: data.slug,
      clientId,
      takeId: serverCopyTakeId,
      sampleRate: recordingSampleRate,
      onProgress: (status) => {
        if (upload === serverCopyUpload) handleServerCopyProgress(status)
      },
      onIssue: issue => session?.reportIssue(issue),
      token: serverCopyToken
    })
    serverCopyUpload = upload
    startServerCopyUploadWhenReady()

    captureTakeName = takeName
    captureSession = session = createCaptureSession({
      sampleRate: recordingSampleRate,
      file: writable,
      upload,
      stopCapture: () => audioEngine.stopCapture(),
      onWritten: i16 => handleWritten(i16, takeName),
      onIssue: handleRecordingIssue,
      onLocalFinished: result => {
        if (sessionDestroyed) return
        // Saved or not, whatever reached the file is now listed for Save.
        if (activeLocalCopyName === takeName) activeLocalCopyName = null
        void refreshLocalCopies()
        if (captureSession !== session || !result.saved) return
        if (!rollingAttempt) recordingState = 'idle'
      },
      onStopRequested: () => {
        if (sessionDestroyed || rollingAttempt || captureSession !== session) return
        void recordingSession.onLocalFailure()
      },
      onMicrophoneNeeded: () => switchToBestMic({ excludeCurrent: true })
    })
    resetTakeMarker()

    recordingSeconds = 0
    recordingStartedAtMs = Date.now()
    return true
  }

  async function stopRecording() {
    checkCoordinator.stop()
    if (rollingAttempt) await attemptRoll
    if (recordingState !== 'recording') return
    recordingState = 'stopping'
    clearInterval(recordingTimer)
    recordingStartedAtMs = null
    wsNotifyState('stopped')
    // Fire-and-forget, never awaited: stopping recognition must never delay
    // the local WAV finalize below (AGENTS.md's one hard rule). Never
    // throws — see $lib/room/transcript-capture.js's doc comment.
    transcriptCapture.stop()

    // stopCapture waits for the worklet's final chunk before the file closes.
    // Local finalize must never wait on the server copy — Save / the wait
    // modal own that gap (ticket 07). session.stop() still finishes both;
    // we only await the local half before asking to save.
    await attemptRoll
    const session = captureSession
    if (session) {
      const takeName = captureTakeName
      const stopPromise = session.stop()
      await session.whenLocalFinished
      if (captureSession === session) {
        captureSession = null
        captureTakeName = null
        recordingState = 'idle'
        resetTakeMarker()
      }
      // A real stop asks to save; a rejected Check Turn's roll does not come through here.
      lastStoppedName = takeName
      savePromptName = takeName
      await refreshLocalCopies()
      void stopPromise.then(result => {
        console.info('[recording] Save result', result)
      }).catch(error => handleRecordingIssue({
        code: 'save-failed', severity: 'error', destination: 'capture',
        message: 'Could not finish the recording after Stop.', error
      }))
    } else {
      // A cancelled roll can seal its old file without attaching a new one.
      // The worklet still needs a real Stop even though there is no writer.
      try { await audioEngine.stopCapture() }
      catch (error) { handleRecordingIssue({ code: 'capture-stop-failed', severity: 'error', destination: 'capture',
        message: 'Audio capture did not acknowledge Stop.', error }) }
      recordingState = 'idle'
      resetTakeMarker()
    }
  }

  let recordingSession = null
  let roomRecording = false
  let recordingControlBusy = false
  let hostRequestMode = null
  let stopConfirmOpen = false
  let otherSideUncertain = false
  let awaitingHostAction = null
  let guestRequestOpen = false
  let guestRequestAction = null
  let guestRequestFrom = ''
  let hostDeclinedToast = ''
  let hostDeclinedToastTimer = null

  function hostIsPresent() {
    return peers.some((p) => p.role === 'host' && p.clientId && p.clientId !== clientId)
  }

  function syncStopUi() {
    roomRecording = recordingSession?.phase() === RECORDING_SESSION_PHASE.recording
    recordingControlBusy = !!recordingSession?.changing
    stopConfirmOpen = !!recordingSession?.awaitingConfirm
    otherSideUncertain = !!recordingSession?.otherSideUncertain
    awaitingHostAction = recordingSession?.awaitingHost || null
    const pending = recordingSession?.pendingGuestRequest
    guestRequestOpen = !!pending && !stopConfirmOpen
    guestRequestAction = pending?.action || null
    guestRequestFrom = pending?.from || ''
    checkCoordinator.contextChanged()
  }

  function showHostDeclinedToast(message) {
    hostDeclinedToast = message
    clearTimeout(hostDeclinedToastTimer)
    hostDeclinedToastTimer = setTimeout(() => {
      hostDeclinedToast = ''
      hostDeclinedToastTimer = null
    }, 4000)
  }

  async function toggleRecording() {
    await recordingSession.onToggle()
    syncStopUi()
  }

  function confirmSyncedStop() {
    recordingSession.confirmStop()
    syncStopUi()
    startTakeCountdownTick()
  }

  function cancelSyncedStop() {
    recordingSession.cancelStop()
    syncStopUi()
  }

  async function acceptGuestRecordingRequest() {
    await recordingSession.acceptGuestRequest()
    syncStopUi()
    if (stopConfirmOpen) return
    if (recordingState === 'recording') startTakeCountdownTick()
  }

  function dismissGuestRecordingRequest() {
    recordingSession.dismissGuestRequest()
    syncStopUi()
  }


  // A take that ended some other way (e.g. a failed retake roll) has nothing left to confirm.
  $: if (stopConfirmOpen && recordingState !== 'recording') cancelSyncedStop()

  $: {
    peers; wsStatus; awaitingHostAction; recordingState; roomRecording;
    hostRequestMode = recordingSession?.buttonMode ?? null
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
    const delayMs = localTriggerDelayMs(triggerAtMs, clockOffset)
    audioEngine.scheduleClapTone(delayMs)
    flashClap(from)
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
    if (state === 'recording' && recordingStartedAtMs == null) {
      recordingStartedAtMs = Date.now() - recordingSeconds * 1000
    }
    room.send({
      type: 'recording_state',
      state,
      startedAt: state === 'recording' ? recordingStartedAtMs : undefined
    })
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
      if (msg.type === 'presence') {
        peers = msg.peers
        pruneCheckPreviews(msg.peers)
        checkCoordinator.receive(msg)
        checkCoordinator.contextChanged()
      }
      if (msg.type === 'recording_session') checkCoordinator.receive(msg)
      // Exclusive reply to our own 'join' — see ws-rooms.js's doc comment.
      // Guard on clientId anyway: never let a stale/mismatched token from
      // a previous identity get applied to this one.
      if (msg.type === 'server_copy_token' && msg.clientId === clientId) {
        serverCopyToken = msg.token
        startServerCopyUploadWhenReady()
      }
      if (msg.type === 'pong') {
        clockSync.handlePong(msg)
        clockOffset = clockSync.offset
      }
      if (msg.type === 'clap') {
        // Flash even when the audio graph isn't up yet (no mic). Queue the
        // tone for when the worklet starts; injectClap does both.
        if (!audioEngineReady) {
          flashClap(msg.from)
          pendingClaps.push({ from: msg.from, triggerAtMs: msg.triggerAtMs })
        } else injectClap(msg.from, msg.triggerAtMs)
      }
      // A late tail echo after this file already closed (the host's 2500ms
      // fallback) has nothing left to stop.
      if (
        msg.type === TAKE_MARKER_TYPE
        && checkCoordinator.acceptsPreview(msg)
        && (msg.edge !== TAKE_MARKER_EDGE_END || recordingState === 'recording')
      ) {
        flashClap(msg.from)
        takeMarker.receive({ triggerAtMs: msg.triggerAtMs, offset: clockOffset, edge: msg.edge })
        startTakeCountdownTick()
      }
      if (msg.type === 'tabs_state') {
        roomTabs?.applyTabsState?.(msg)
        // ResearchPanel only needs to know which tab is active (to scope
        // which tab's history it shows) — fed from this same broadcast
        // RoomTabs derives its own activeTabId from, never a second,
        // independently-tracked copy that could drift from it.
        researchPanel?.applyTabsState?.(msg)
      }
      if (msg.type === 'tab_video')  roomTabs?.applyTabVideo?.(msg)
      // ResearchPanel does NOT get a second, independent routing line here
      // for tab_text (unlike tabs_state/transcript_state/transcript_line
      // below) — it reads RoomTabs' own `tabTexts` directly via the
      // `bind:tabTexts` prop plumbing instead. RoomTabs is the only place
      // that holds the true, complete, current value for every tab (both
      // its own just-typed keystrokes AND every peer's broadcast text) —
      // the tab_text broadcast itself deliberately excludes the sender (so
      // a typist's own Notes surface isn't clobbered by an echo of its own
      // keystrokes), which is lossy for anyone re-deriving a second copy
      // from it, exactly the case a solo participant typing their own
      // notes would hit.
      if (msg.type === 'tab_text')   roomTabs?.applyTabText?.(msg)
      // The Transcript is state this page owns since ticket 06, not a
      // message fanned out to two components that each kept their own copy.
      // Both children read `transcriptLines` as a plain prop instead.
      if (msg.type === 'transcript_state') {
        transcriptLines = reduceTranscriptState(transcriptLines, msg)
      }
      if (msg.type === 'transcript_line') {
        transcriptLines = reduceTranscriptLine(transcriptLines, msg)
      }
      if (msg.type === 'research_entry') researchPanel?.applyResearchEntry?.(msg)
      if (msg.type === 'research_state') researchPanel?.applyResearchState?.(msg)
      if (msg.type === 'research_removed') researchPanel?.applyResearchRemove?.(msg)
      // Annotations (ADR-0008) go to BOTH: the panel lists them, and
      // RoomTabs draws their quotes back onto the Notes text they were
      // taken from (ticket 04) — as well as needing the echo of its own
      // annotation_create to know the server has it and stop re-sending it
      // on reconnect (see annotation-outbox.js).
      if (msg.type === 'annotation_entry') {
        researchPanel?.applyAnnotationEntry?.(msg)
        roomTabs?.applyAnnotationEntry?.(msg)
      }
      if (msg.type === 'annotation_state') {
        researchPanel?.applyAnnotationState?.(msg)
        roomTabs?.applyAnnotationState?.(msg)
      }
      // A Card's lookup failed (ticket 05). Routed to both for the same
      // reasons annotation_entry is: the panel has to show the reason, and
      // RoomTabs has to stop re-sending an ask the server has clearly
      // already seen.
      if (msg.type === 'annotation_error') {
        researchPanel?.applyAnnotationError?.(msg)
        roomTabs?.applyAnnotationError?.(msg)
      }
      if (msg.type === 'annotation_removed') {
        researchPanel?.applyAnnotationRemove?.(msg)
        roomTabs?.applyAnnotationRemove?.(msg)
      }
      if (msg.type === 'yt_duck')    roomTabs?.applyDuck?.(msg)
      // The "something's coming" pulse moved with the Transcript itself
      // (ticket 06): it now rides the panel's Transcript facet button (and
      // its collapse toggle when the panel is shut), not a tab-strip pill.
      if (msg.type === 'transcript_activity') researchPanel?.applyTranscriptActivity?.(msg)
      if (msg.type === 'recording_check_preview') applyCheckPreview(msg)
      if (msg.type === RECORDING_SESSION_TYPE || msg.type === RECORDING_SESSION_REQUEST_TYPE) {
        const wasAwaiting = recordingSession?.awaitingHost || null
        void recordingSession.onMessage(msg).then(() => {
          syncStopUi()
          if (
            msg.type === RECORDING_SESSION_REQUEST_TYPE
            && msg.action === RECORDING_SESSION_REQUEST_ACTION.dismissed
            && wasAwaiting
            && !recordingSession.awaitingHost
          ) {
            showHostDeclinedToast(
              wasAwaiting === RECORDING_SESSION_REQUEST_ACTION.stop
                ? HOST_DECLINED_STOP
                : HOST_DECLINED_START
            )
          }
        })
      }
      if (msg.type === 'error')     console.warn('WS error:', msg.message)
    },
    onStatusChange(status) {
      wsStatus = status
      syncStopUi()
    }
  })

  room.registerResync(() => {
    roomTabs?.resyncDuck?.()
  })
  recordingSession = createRecordingSession({
    send: (payload) => room.send(payload),
    startLocal: startRecording,
    stopLocal: stopRecording,
    getRecordingState: () => recordingState,
    isHost: () => !!data.isHostClaim,
    getWsStatus: () => wsStatus,
    isHostPresent: hostIsPresent,
    requestTail: () => takeMarker.requestTail({ synced: true }),
    onChange: syncStopUi,
    onIssue: handleRecordingIssue
  })
  takeMarker = createTakeMarker({
    send: (msg) => room.send({ ...msg, sessionId: checkView.sessionId, roundId: checkView.roundId }),
    isHost: () => !!data.isHostClaim,
    getWsStatus: () => wsStatus,
    getEngineReady: () => audioEngineReady,
    scheduleTone: (delayMs) => audioEngine.scheduleClapTone(delayMs),
    getSamplesWritten: () => captureSession?.samplesWritten ?? 0,
    onTakeReady: ({ startSample }) => {
      takeReady = true
      takeStartSample = startSample
      takeCountdownSec = 0
      clearInterval(takeCountdownTimer)
      takeCountdownTimer = null
    },
    onTail: (info) => {
      takeCountdownSec = 0
      clearInterval(takeCountdownTimer)
      takeCountdownTimer = null
      const stopped = recordingSession.onTail(info)
      syncStopUi()
      stopped
        .catch((err) => console.error('Synced stop failed', err))
        .finally(syncStopUi)
    }
  })

  room.registerResync(() => {
    if (recordingState === 'recording') wsNotifyState('recording')
  })
  room.registerResync(() => {
    recordingSession.resync()
  })
  room.registerResync(() => {
    // The server forgets peer state across a dropped connection (a fresh
    // peer object is created on rejoin — see ws-rooms.js), so this must
    // re-announce itself here just like the recording resync above, or the
    // server-copy pill would silently reset to "unavailable" after any
    // reconnect and stay wrong for the rest of the session.
    if (serverCopyUpload) sendServerCopyProgress(deriveServerCopyDisplay(serverCopyUpload.getStatus()), { force: true })
  })
  room.registerResync(() => {
    sendMicInfo(true)
  })
  room.registerResync(() => checkCoordinator.resync())
  room.registerResync(() => {
    // A Comment submitted into a dropped socket is real, local, unsaved
    // state the server has never heard of — room.send() drops it silently
    // (see room-connection.js). Same class of bug as the stuck Recording
    // pill AGENTS.md warns about, so it uses the same mechanism rather than
    // a bespoke retry. Re-sending is safe: annotation_create is idempotent
    // by id (see room-state-store.js's addAnnotation).
    roomTabs?.resyncAnnotations?.()
  })

  $: micLabel = (
    devices.find((d) => d.deviceId === selectedDeviceId)?.label
    || micFallbackName
    || ''
  ).slice(0, 80)

  let lastMicSent = null
  function sendMicInfo(force = false) {
    if (!force && micLabel === lastMicSent) return
    lastMicSent = micLabel
    room.send({ type: 'mic_info', label: micLabel })
  }

  $: if (browser && wsStatus === "connected") {
    micLabel;
    sendMicInfo();
  }

  function connectWs() {
    if (sessionDestroyed || !data.authenticated) return
    room.connect()
  }

  // ───────────────────────────────────────────────────────────────────
  // DEVICE CHANGE DETECTION
  // ───────────────────────────────────────────────────────────────────

  async function onDeviceChange() {
    try {
      if (audioEngineReady) await audioEngine.refreshMicrophones()
      else await loadDevices()
    } catch (error) {
      handleRecordingIssue({ code: 'mic-assessment-failed', severity: 'warning', destination: 'capture', message: 'Could not refresh microphones.', error })
    }
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
      void refreshLocalCopies()
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
      document.addEventListener('click', wakeAudio, { capture: true })
      document.addEventListener('keydown', wakeAudio, { capture: true })
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
    canvas
    sidebarCollapsed
    tick().then(waveformRenderer.resizeCanvas)
  }

  $: if (data.participantName?.trim()) nameGateShow = false

  onDestroy(() => {
    if (!browser) return
    sessionDestroyed = true
    checkCoordinator.dispose()
    waveformRenderer.stop()
    transcriptCapture.stop()
    clearInterval(recordingTimer)
    clearTimeout(clapTimeout)
    levelMeter.close()
    if (copyLinkTimer) clearTimeout(copyLinkTimer)
    window.removeEventListener('beforeunload', handleBeforeUnload)
    document.removeEventListener('click', handleDocumentClick, { capture: true })
    document.removeEventListener('click', wakeAudio, { capture: true })
    document.removeEventListener('keydown', wakeAudio, { capture: true })
    window.removeEventListener('themechange', refreshWaveformColors)
    room.disconnect()
    // Stop flushes the worklet before closing its AudioContext. Keep any file
    // already opened by a cancelled roll; its capture owner seals it here.
    void (async () => {
      await attemptRoll.catch(() => {})
      const session = captureSession
      if (session) {
        void session.stop().catch(error => handleRecordingIssue({ code: 'save-failed', severity: 'error', destination: 'capture',
          message: 'Could not finish the recording while leaving the room.', error }))
        await session.whenLocalFinished
      }
    })().catch(error => handleRecordingIssue({ code: 'save-failed', severity: 'error', destination: 'local',
      message: 'Could not finish the recording while leaving the room.', error }))
      .finally(() => audioEngine.close())
    clearAllCheckPreviews()
    navigator.mediaDevices?.removeEventListener('devicechange', onDeviceChange)
  })
</script>

<svelte:head>
  <title>{data.roomName} — Podpatch</title>
</svelte:head>

{#if !data.authenticated}
  <PasswordGate roomName={data.roomName} formError={form?.error} bind:myName clientId={clientId || ''} />
{:else if nameGateShow}
  <DisplayNameGate roomName={data.roomName} formError={form?.error} bind:myName />
{:else if joinStep === JOIN_STEP.unsupported}
  <UnsupportedBrowserGate slug={data.slug} />
{:else if showsMic(joinStep)}
  <JoinMicStep
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
    onContinue={continueFromMic}
  />
{:else}
  <RecordingRoom
    bind:sidebarCollapsed
    bind:researchCollapsed
    bind:researchFacet
    bind:roomTabs
    bind:researchPanel
    bind:tabTexts
    {transcriptLines}
    {transcriptionStatus}
    bind:canvasEl={canvas}
    roomName={data.roomName}
    slug={data.slug}
    isHostClaim={data.isHostClaim}
    guestCanAskResearch={data.guestCanAskResearch}
    customPrompts={data.customPrompts}
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
    {peakHoldDb}
    {isClipping}
    {lastClapFrom}
    {takeCountdownSec}
    {recordingState}
    {roomRecording}
    {canRecord}
    {myPeerIsRecording}
    {recordingSeconds}
    {bytesWritten}
    {hostRequestMode}
    {checkPreviewByClientId}
    {stayQuietRole}
    {localCopies}
    onSaveLocalCopy={onLocalCopySaveClick}
    onRemoveLocalCopy={onLocalCopyRemoveClick}
    {savedLocalCopyNames}
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
  quietRole={checkView.presentation === 'waiting' ? stayQuietRole || '' : ''}
  retaking={checkView.presentation === 'retaking'}
  onDismiss={() => checkCoordinator.dismiss()}
  {micLabel}
  onListen={buildCheckPreview}
  onIssue={handleRecordingIssue}
  onConfirm={confirmRecordingCheck}
  onReject={rejectRecordingCheck}
/>
{#if checkView.canShow}
  <div class="check-pending" role="status">
    Microphone check pending.
    <button type="button" class="btn-secondary" on:click={() => checkCoordinator.show()}>Show check</button>
  </div>
{/if}
<div
  hidden
  data-testid="check-turn"
  data-check-turn={checkTurn}
  data-both-turns-passed={bothTurnsPassed ? 'true' : 'false'}
></div>
<div
  hidden
  data-testid="take-marker"
  data-take-ready={takeReady ? 'true' : 'false'}
  data-take-start-sample={takeStartSample}
></div>
{#if stopConfirmOpen}
  <div class="stop-confirm-overlay">
    <div
      class="stop-confirm-card"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="stop-confirm-title"
      data-testid="stop-confirm"
    >
      <h2 id="stop-confirm-title">{STOP_BOTH_CONFIRM}</h2>
      <div class="stop-confirm-actions">
        <button type="button" class="btn-ghost" on:click={cancelSyncedStop}>Keep recording</button>
        <button type="button" class="btn-primary" on:click={confirmSyncedStop}>Stop for both</button>
      </div>
    </div>
  </div>
{/if}
<Model
  open={guestRequestOpen && guestRequestAction === RECORDING_SESSION_REQUEST_ACTION.start}
  labelledBy="guest-request-title"
  actions={[
    { label: 'No', onClick: dismissGuestRecordingRequest },
    { label: 'Yes, start', onClick: acceptGuestRecordingRequest, primary: true }
  ]}
>
  <div data-testid="guest-record-request">
    <h2 id="guest-request-title" class="guest-request-title">{GUEST_WANTS_START_TITLE}</h2>
    <p class="guest-request-body">{guestWantsStartCopy(guestRequestFrom)}</p>
  </div>
</Model>
<Model
  open={guestRequestOpen && guestRequestAction === RECORDING_SESSION_REQUEST_ACTION.stop}
  labelledBy="guest-stop-request-title"
  actions={[
    { label: 'No', onClick: dismissGuestRecordingRequest },
    { label: 'Yes, stop', onClick: acceptGuestRecordingRequest, primary: true }
  ]}
>
  <div data-testid="guest-stop-request">
    <h2 id="guest-stop-request-title" class="guest-request-title">{GUEST_WANTS_STOP_TITLE}</h2>
    <p class="guest-request-body">{guestWantsStopCopy(guestRequestFrom)}</p>
  </div>
</Model>
{#if hostDeclinedToast}
  <div class="host-declined-toast" role="status" aria-live="polite" data-testid="host-declined-toast">
    {hostDeclinedToast}
  </div>
{/if}
{#if audioEngineReady && audioState === 'suspended'}
  <div class="audio-paused" role="alert" data-testid="audio-paused">
    <span>Your browser has paused the mic. Nothing is being recorded from it.</span>
    <button type="button" class="btn-primary" on:click={wakeAudio}>Turn mic back on</button>
  </div>
{/if}
{#if otherSideUncertain && recordingState === 'idle'}
  <div class="other-side-uncertain" role="status" data-testid="other-side-uncertain">
    {OTHER_SIDE_UNCERTAIN}
  </div>
{/if}
<LocalCopySavePrompt
  take={savePromptTake}
  uploading={hasIncompleteServerCopyUpload}
  percent={serverCopyUploadPercent}
  {formatTime}
  onSave={onLocalCopySaveClick}
  onLater={() => { savePromptName = null }}
/>
<ServerCopyWaitModal
  open={showUploadWaitModal}
  percent={serverCopyUploadPercent}
  take={lastStoppedTake}
  onSave={onLocalCopySaveClick}
/>
{/if}

<style>
  .stop-confirm-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 20px;
  }

  .stop-confirm-card {
    background: var(--bg-elevated, #18181b);
    border: 1px solid var(--border, #2a2a2e);
    border-radius: 14px;
    max-width: 420px;
    width: 100%;
    padding: 28px;
    text-align: center;
  }

  .stop-confirm-card h2 {
    font-size: 17px;
    font-weight: 600;
    margin: 0 0 20px;
  }

  .stop-confirm-actions {
    display: flex;
    gap: 8px;
    justify-content: center;
  }

  .other-side-uncertain {
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 900;
    padding: 10px 16px;
    border-radius: 10px;
    border: 1px solid var(--border, #2a2a2e);
    background: var(--bg-elevated, #18181b);
    color: var(--warn-text);
    font-size: 13px;
  }

  .guest-request-title {
    font-size: 17px;
    font-weight: 600;
    margin: 0 0 8px;
  }

  .guest-request-body {
    margin: 0;
    color: var(--muted, #a1a1aa);
    font-size: 14px;
    line-height: 1.5;
  }

  .host-declined-toast {
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 1100;
    padding: 10px 16px;
    border-radius: 10px;
    border: 1px solid var(--border, #2a2a2e);
    background: var(--bg-elevated, #18181b);
    color: var(--text, #fafafa);
    font-size: 13px;
    max-width: min(420px, calc(100vw - 32px));
    text-align: center;
  }

  .audio-paused {
    position: fixed;
    top: 16px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 950;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 16px;
    border-radius: 10px;
    border: 1px solid var(--border, #2a2a2e);
    background: var(--bg-elevated, #18181b);
    color: var(--warn-text);
    font-size: 13px;
  }
</style>
