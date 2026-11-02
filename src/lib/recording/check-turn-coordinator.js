import { createRecordingCheck, createCheckTurnSequence } from './recording-check.js'

/** Check policy only. Attempts and marker sample boundaries remain owned by their adapters. */
export function createCheckTurnCoordinator({ getContext, send, rotateAttempt,
  requestTakeStart, resetTakeMarker = () => {}, onPreviewReady = () => {},
  onChange = () => {}, onIssue = () => {} }) {
  const retiredSessions = new Set()
  const check = createRecordingCheck()
  const sequence = createCheckTurnSequence()
  let state = null, latest = null, active = false, disposed = false
  let hidden = false, retaking = false, ownPassed = false, markerRequested = false
  let lastAnnouncedOpen = null
  let confirmedPreview = null
  let attemptId = null, operation = null, generation = 0, view = Object.freeze({})
  const context = () => getContext()
  const isHost = () => context().role === 'host'
  const own = () => active && !retaking && !ownPassed && !sequence.bothTurnsPassed
    && sequence.shouldOpenOwnCheck({ isHost: isHost() })
  const identity = () => ({ sessionId: state?.sessionId, roundId: state?.roundId,
    revision: state?.revision, attemptId })
  function publish() {
    if (disposed) return
    if (context().activeDialog) hidden = true
    const pending = active && !sequence.bothTurnsPassed
    const quiet = pending ? sequence.stayQuietRole({ isHost: isHost() }) : null
    view = Object.freeze({ ...identity(), participantId: context().participantId, role: context().role, turn: active ? sequence.turn : 'idle',
      sentence: check.sentence, ownCheckVisible: own() && !hidden,
      waiting: !!quiet, retaking, stayQuietRole: quiet,
      presentation: !pending || hidden ? null : retaking ? 'retaking' : own() ? 'own' : 'waiting',
      complete: active && sequence.bothTurnsPassed, pending,
      canShow: pending && hidden, canConfirm: own(), canReject: own() })
    onChange(view)
    if (active && (own() && !hidden) !== lastAnnouncedOpen) announce()
  }
  function announce(action) {
    if (!active || disposed || !state) return
    lastAnnouncedOpen = own() && !hidden
    send({ type: 'recording_check', ...identity(), action, open: own() && !hidden, turn: sequence.turn })
  }
  function preview() {
    const current = check.sharePcm()
    if (current.length) confirmedPreview = current
    const pcm = confirmedPreview || current
    if (active && !disposed && pcm.length) onPreviewReady({ pcm, ...identity() })
  }
  function refresh() {
    if (own() && !check.open) check.start()
    if (!own() && check.open) check.close()
    publish()
    if (active && sequence.bothTurnsPassed && !markerRequested) {
      markerRequested = true
      if (!state.synced || isHost()) requestTakeStart({ ...identity(), synced: state.synced })
    }
  }
  function apply(next, adoptSession = false) {
    if (!active || disposed || !next) return
    if (state && next.sessionId !== state.sessionId && !adoptSession) return
    if (state && next.sessionId === state.sessionId && (next.roundId < state.roundId
      || (next.roundId === state.roundId && next.revision <= state.revision))) return
    const newRound = !state || next.sessionId !== state.sessionId || next.roundId !== state.roundId
    const wasRetaking = retaking
    const previous = state
    state = { ...next }
    if (newRound) {
      operation?.abort(); operation = null; generation++
      retaking = false; ownPassed = false; markerRequested = false; confirmedPreview = null
      check.close()
      sequence.start({ synced: next.synced })
      if (previous && (previous.sessionId !== next.sessionId || (!previous.synced && next.synced))) resetTakeMarker()
    }
    if (!newRound && previous.synced !== next.synced) sequence.start({ synced: next.synced })
    if (next.synced || next.turn === 'passed') sequence.applyRemote(next.turn)
    if (newRound && previous && (next.retake || wasRetaking)) { void rotate(); return }
    refresh()
  }
  async function rotate() {
    operation?.abort()
    const controller = operation = new AbortController()
    const token = ++generation
    retaking = true
    check.close(); publish()
    let result
    try { result = await rotateAttempt({ signal: controller.signal, ...identity() }) }
    catch (error) { result = { status: 'failed', error } }
    if (disposed || !active || token !== generation || controller.signal.aborted) return
    operation = null; retaking = false
    if (result?.status !== 'ready') {
      if (result?.status !== 'cancelled') onIssue({ code: 'check-retake-failed', severity: 'error', destination: 'capture',
        message: 'Could not open the next microphone check attempt.', error: result?.error })
      stop(); return
    }
    attemptId = result.attemptId
    refresh(); announce()
  }
  function start() {
    if (disposed || !context().recording || active) return
    active = true; hidden = false; ownPassed = false; markerRequested = false
    attemptId = context().attemptId
    state = null
    const initial = latest || { sessionId: context().sessionId || `local-${context().participantId}-${++generation}`,
      roundId: 1, revision: 0, synced: false, turn: 'idle' }
    apply(initial); announce()
  }
  function confirm() {
    if (!own() || disposed) return
    preview()
    check.confirm(); ownPassed = true
    if (context().connected && !String(state.sessionId).startsWith('local-')) announce('confirm')
    else {
      sequence.confirm({ isHost: isHost() })
      state = { ...state, turn: sequence.turn, revision: state.revision + 1 }
    }
    refresh()
  }
  function dismiss() {
    if (!active || hidden || disposed) return
    hidden = true
    if (own()) confirm()
    publish()
  }
  function reject() {
    if (!own() || disposed) return
    check.reject(); ownPassed = true
    if (context().connected && !String(state.sessionId).startsWith('local-')) announce('reject')
    else {
      apply({ ...state, roundId: state.roundId + 1, revision: 0, retake: true, turn: 'idle' })
    }
    publish()
  }
  function stop() {
    if (disposed) return
    if (state) retiredSessions.add(state.sessionId)
    active = false; generation++; operation?.abort(); operation = null
    retaking = false; confirmedPreview = null; check.close(); sequence.close(); state = null
    publish()
  }
  function receive(event) {
    if (disposed) return
    if (event.type === 'recording_session') {
      if (event.initialized === false || retiredSessions.has(event.sessionId)) return
      if (event.phase === 'idle') { latest = null; stop(); return }
      if (event.check) {
        if (latest?.sessionId === event.check.sessionId && (event.check.roundId < latest.roundId
          || (event.check.roundId === latest.roundId && event.check.revision < latest.revision))) return
        const changedSession = state && event.check.sessionId !== state.sessionId
        if (changedSession) retiredSessions.add(state.sessionId)
        latest = event.check
        apply(event.check, !!changedSession)
      }
    } else if (event.type === 'presence' && event.check) apply(event.check)
  }
  function resync() { if (active && !disposed) { announce(); preview() } }
  function contextChanged() { if (active && !context().recording) stop(); else publish() }
  function dispose() { stop(); disposed = true }
  return { start, confirm, reject, dismiss, stop, receive, resync, contextChanged, dispose,
    show() { if (active && !sequence.bothTurnsPassed && !context().activeDialog) { hidden = false; publish() } },
    handleWritten(i16, metadata = {}) {
      if (!active || disposed || retaking || metadata.attemptId !== attemptId) return
      check.handleWritten(i16)
      if (check.consumeAutoShare()) preview()
    },
    buildPreview(sampleRate) { preview(); return check.buildPreview(sampleRate) },
    acceptsPreview(event) { return active && !disposed && event.sessionId === state?.sessionId && event.roundId === state?.roundId },
    get view() { return view }
  }
}
