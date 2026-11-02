/** Room recording control. The server owns the desired phase and pending
 * request; each browser reconciles its recorder with those snapshots. Local
 * capture and destination finalization remain in recording-session.js. */

export const RECORDING_SESSION_TYPE = 'recording_session'
export const RECORDING_SESSION_SYNC_TYPE = 'recording_session_sync'

export const RECORDING_SESSION_REQUEST_TYPE = 'recording_session_request'

export const RECORDING_SESSION_PHASE = {
  idle: 'idle',
  recording: 'recording'
}

export const RECORDING_SESSION_REQUEST_ACTION = {
  start: 'start',
  stop: 'stop',
  dismissed: 'dismissed'
}

export const RECORDING_SESSION_HOST_ONLY =
  'Only the host can control the recording session.'

export const STOP_BOTH_CONFIRM =
  'Stop recording for both of you? This ends the take.'

export const OTHER_SIDE_UNCERTAIN =
  'The other side may still be recording.'

export const REQUEST_START_LABEL = 'Request to start recording'
export const REQUEST_STOP_LABEL = 'Request to stop recording'
export const WAITING_FOR_HOST_LABEL = 'Waiting for host…'

export const GUEST_WANTS_START_TITLE = 'Start recording?'
export const GUEST_WANTS_STOP_TITLE = 'Stop recording?'

export const HOST_DECLINED_START =
  "The host isn't ready to start yet."
export const HOST_DECLINED_STOP =
  'The host wants to keep recording.'

export function guestWantsStartCopy(name) {
  const who = String(name || 'Your guest').trim() || 'Your guest'
  return `${who} wants to start recording.`
}

export function guestWantsStopCopy(name) {
  const who = String(name || 'Your guest').trim() || 'Your guest'
  return `${who} wants to stop recording.`
}

/** Guest record-button mode when the host is in the room. */
export function guestRecordButtonMode({ hostPresent, awaitingHost, recordingState }) {
  if (!hostPresent) return null
  if (awaitingHost === RECORDING_SESSION_REQUEST_ACTION.start) return 'waiting-start'
  if (awaitingHost === RECORDING_SESSION_REQUEST_ACTION.stop) return 'waiting-stop'
  if (recordingState === 'recording') return 'request-stop'
  if (recordingState === 'idle') return 'request-start'
  return null
}

export function recordingSessionMessage(phase) {
  return { type: RECORDING_SESSION_TYPE, phase }
}

export function recordingSessionRequestMessage(action) {
  return { type: RECORDING_SESSION_REQUEST_TYPE, action }
}

export function usesSyncedRecordingSession({ wsStatus, isHost }) {
  return wsStatus === 'connected' && !!isHost
}

export function isRecordingSessionPhase(phase) {
  return phase === RECORDING_SESSION_PHASE.idle || phase === RECORDING_SESSION_PHASE.recording
}

export function isRecordingSessionRequestAction(action) {
  return action === RECORDING_SESSION_REQUEST_ACTION.start
    || action === RECORDING_SESSION_REQUEST_ACTION.stop
    || action === RECORDING_SESSION_REQUEST_ACTION.dismissed
}

/** Server half of the same recording-control module. Transport and peer identity
 * are supplied by ws-rooms; browsers cannot grant themselves host authority. */
export function createRoomRecordingState({ publish, reply, onCheckReset = () => {} }) {
  let phase = RECORDING_SESSION_PHASE.idle
  let initialized = false
  let peers = []
  let request = null
  let membership = ''
  let sessionId = null
  let check = null
  let round = 0
  const passed = new Set()
  const participants = new Set()
  const paired = () => peers.some(p => p.role === 'host') && peers.some(p => p.role !== 'host')
  function newCheck({ retake = false } = {}) {
    passed.clear()
    const synced = paired()
    check = { sessionId, roundId: ++round, revision: 0, synced, retake,
      turn: synced ? 'host' : 'idle' }
  }
  const host = () => peers.find(peer => peer.role === 'host')
  const controls = id => !host() || host().clientId === id
  const snapshot = () => ({ type: RECORDING_SESSION_TYPE, phase, initialized,
    hostClientId: host()?.clientId ?? null, request, sessionId, check })
  function setPhase(next) {
    if (next === RECORDING_SESSION_PHASE.recording && phase !== next) {
      sessionId = globalThis.crypto.randomUUID()
      round = 0
      participants.clear()
      for (const p of peers) participants.add(p.clientId)
      newCheck()
      onCheckReset()
    }
    if (next === RECORDING_SESSION_PHASE.idle) check = null
    phase = next
    initialized = true
    request = null
    publish(snapshot())
  }
  function presence(nextPeers) {
    const previousPaired = paired()
    const samePeers = peers.length === nextPeers.length && peers.every(peer => nextPeers.includes(peer))
    peers = nextPeers
    const nextMembership = peers.map(peer => `${peer.clientId}:${peer.role}`).sort().join(',')
    if (membership === nextMembership && samePeers) return null
    membership = nextMembership
    if (phase === RECORDING_SESSION_PHASE.recording && previousPaired !== paired()) {
      const newcomer = peers.some(p => !participants.has(p.clientId))
      if (paired() && newcomer) newCheck()
      else if (check) {
        const complete = peers.length > 0 && peers.every(p => passed.has(p.clientId))
        check = { ...check, synced: paired(), revision: check.revision + 1,
          turn: complete ? 'passed' : paired() ? passed.has(host().clientId) ? 'guest' : 'host' : 'idle' }
      }
      for (const p of peers) participants.add(p.clientId)
      onCheckReset()
    }
    if (request && !peers.some(peer => peer.clientId === request.clientId)) request = null
    // Approval is no longer needed once the host leaves.
    if (request && !host()) {
      const next = request.action === 'start' ? RECORDING_SESSION_PHASE.recording : RECORDING_SESSION_PHASE.idle
      if (next === RECORDING_SESSION_PHASE.recording && phase !== next) {
        sessionId = globalThis.crypto.randomUUID()
        round = 0
        participants.clear()
        for (const p of peers) participants.add(p.clientId)
        newCheck()
        onCheckReset()
      }
      if (next === RECORDING_SESSION_PHASE.idle) check = null
      phase = next
      initialized = true
      request = null
    }
    return snapshot()
  }
  function receive(clientId, message) {
    const peer = peers.find(peer => peer.clientId === clientId)
    if (!peer) return
    if (message.type === 'recording_check') {
      if (!check || phase !== 'recording' || message.sessionId !== sessionId
        || message.roundId !== check.roundId || message.revision !== check.revision) {
        reply(clientId, snapshot())
        return
      }
      const own = check.turn !== 'passed' && (!check.synced || check.turn === peer.role)
      if (message.action === 'confirm' && own) {
        passed.add(clientId)
        check = { ...check, revision: check.revision + 1,
          turn: check.synced && peer.role === 'host' ? 'guest' : 'passed' }
      } else if (message.action === 'reject' && own) newCheck({ retake: true })
      publish(snapshot())
    } else if (message.type === RECORDING_SESSION_SYNC_TYPE) {
      // Recover after an empty room/server restart, but never let an old
      // browser overwrite an already-known room state during reconnect.
      if (!initialized && controls(clientId) && isRecordingSessionPhase(message.phase)) setPhase(message.phase)
      else reply(clientId, snapshot())
    } else if (message.type === RECORDING_SESSION_TYPE && isRecordingSessionPhase(message.phase)) {
      if (controls(clientId)) setPhase(message.phase)
      else {
        reply(clientId, { type: 'error', message: RECORDING_SESSION_HOST_ONLY })
        reply(clientId, snapshot())
      }
    } else if (message.type === RECORDING_SESSION_REQUEST_TYPE && isRecordingSessionRequestAction(message.action)) {
      if (message.action === 'dismissed') {
        if (controls(clientId) || request?.clientId === clientId) {
          const declined = request
          request = null
          if (declined && controls(clientId)) reply(declined.clientId, {
            type: RECORDING_SESSION_REQUEST_TYPE, action: 'dismissed', from: peer.name, clientId
          })
          publish(snapshot())
        }
      } else if (initialized && phase === (message.action === 'start' ? RECORDING_SESSION_PHASE.recording : RECORDING_SESSION_PHASE.idle)) {
        // A request overtaken by the host's decision is already satisfied.
        reply(clientId, snapshot())
      } else if (controls(clientId)) {
        setPhase(message.action === 'start' ? RECORDING_SESSION_PHASE.recording : RECORDING_SESSION_PHASE.idle)
      } else if (!request) {
        request = { action: message.action, from: peer.name, clientId }
        publish(snapshot())
      } else reply(clientId, snapshot())
    }
  }
  return { presence, receive, controls, get check() { return check } }
}

export function createRecordingSession({
  send, startLocal, stopLocal, getRecordingState, isHost, getWsStatus,
  isHostPresent = () => false, requestTail, onChange = () => {}, onIssue = () => {}
}) {
  let phase = RECORDING_SESSION_PHASE.idle
  let known = false
  let awaitingConfirm = false
  let otherSideUncertain = false
  let awaitingHost = null
  let pendingGuestRequest = null
  let changing = false
  let localIntent = null
  let reconciling = null
  let generation = 0
  let attempted = -1
  let starting = null
  const controls = () => isHost() || !isHostPresent()
  const connected = () => getWsStatus() === 'connected'
  function notify() { onChange() }

  function reconcile() {
    if (reconciling) return reconciling
    reconciling = Promise.resolve().then(async () => {
      while (true) {
        const state = getRecordingState()
        if (phase === RECORDING_SESSION_PHASE.recording && state === 'idle' && attempted !== generation) {
          attempted = generation
          const controller = new AbortController()
          starting = controller
          try { await startLocal({ signal: controller.signal }) } catch (error) {
            if (!controller.signal.aborted) onIssue({ code: 'capture-start-failed', severity: 'error', destination: 'capture',
              message: 'Could not start local recording for the room session.', error })
          } finally { starting = null }
          continue
        }
        if (phase === RECORDING_SESSION_PHASE.idle && state === 'recording') {
          await stopLocal()
          continue
        }
        break
      }
    }).finally(() => { reconciling = null; notify() })
    notify()
    return reconciling
  }
  function applyPhase(next) {
    if (next !== phase) { generation++; otherSideUncertain = false }
    phase = next
    if (next === RECORDING_SESSION_PHASE.idle) starting?.abort()
    known = true
    changing = false
    if (next === RECORDING_SESSION_PHASE.idle) awaitingConfirm = false
    notify()
    return reconcile()
  }
  async function change(next) {
    pendingGuestRequest = null
    if (connected()) {
      changing = true
      notify()
      send(recordingSessionMessage(next))
    } else {
      localIntent = next
      await applyPhase(next)
    }
  }
  async function onToggle() {
    if ((connected() && changing) || reconciling || (connected() && awaitingHost) || awaitingConfirm || getRecordingState() === 'stopping') return
    const active = known ? phase === RECORDING_SESSION_PHASE.recording : getRecordingState() === 'recording'
    if (connected() && !controls()) {
      awaitingHost = active ? 'stop' : 'start'
      notify()
      send(recordingSessionRequestMessage(awaitingHost))
    } else if (active && connected() && isHost()) {
      awaitingConfirm = true
      notify()
    } else await change(active ? RECORDING_SESSION_PHASE.idle : RECORDING_SESSION_PHASE.recording)
  }
  function confirmStop() {
    if (!awaitingConfirm) return
    awaitingConfirm = false
    pendingGuestRequest = null
    requestTail?.()
    notify()
  }
  function cancelStop() { awaitingConfirm = false; notify() }
  async function onTail({ uncertain = false } = {}) {
    otherSideUncertain = uncertain
    // Finalize independently of the socket/other participant, exactly once.
    phase = RECORDING_SESSION_PHASE.idle
    starting?.abort()
    try { if (getRecordingState() === 'recording') await stopLocal() }
    finally {
      if (connected() && controls()) send(recordingSessionMessage(RECORDING_SESSION_PHASE.idle))
      else if (!connected()) localIntent = RECORDING_SESSION_PHASE.idle
      notify()
    }
  }
  async function acceptGuestRequest() {
    if (!isHost() || !pendingGuestRequest) return
    const action = pendingGuestRequest.action
    pendingGuestRequest = null
    if (action === 'stop' && getRecordingState() === 'recording') {
      // Accepting the guest's request is already confirmation.
      awaitingConfirm = true
      confirmStop()
    } else await change(action === 'start' ? RECORDING_SESSION_PHASE.recording : RECORDING_SESSION_PHASE.idle)
  }
  async function onLocalFailure() {
    // Stop this recorder immediately; a socket round-trip must never gate
    // finalization after a permanent save failure.
    if (connected()) {
      if (controls()) send(recordingSessionMessage(RECORDING_SESSION_PHASE.idle))
      else {
        awaitingHost = 'stop'
        send(recordingSessionRequestMessage('stop'))
      }
    } else {
      localIntent = RECORDING_SESSION_PHASE.idle
      phase = RECORDING_SESSION_PHASE.idle
      known = true
    }
    starting?.abort()
    notify()
    await stopLocal()
    notify()
  }
  function dismissGuestRequest() {
    if (!isHost() || !pendingGuestRequest) return
    pendingGuestRequest = null
    send(recordingSessionRequestMessage('dismissed'))
    notify()
  }
  async function onMessage(message) {
    if (!message) return
    if (message.type === RECORDING_SESSION_REQUEST_TYPE) {
      if (!isRecordingSessionRequestAction(message.action)) return
      if (message.action === 'dismissed') { awaitingHost = null; pendingGuestRequest = null }
      else if (isHost()) pendingGuestRequest = { action: message.action, from: message.from || '', clientId: message.clientId || '' }
      notify()
      return
    }
    if (message.type !== RECORDING_SESSION_TYPE || !isRecordingSessionPhase(message.phase)) return
    if (Object.hasOwn(message, 'request')) {
      pendingGuestRequest = isHost() ? message.request : null
      awaitingHost = !isHost() ? message.request?.action ?? null : null
    } else awaitingHost = null
    if (message.initialized === false) { notify(); return }
    await applyPhase(message.phase)
    notify()
  }
  function resync() {
    const intent = localIntent
    localIntent = null
    if (intent && controls()) {
      send(recordingSessionMessage(intent))
    } else send({ type: RECORDING_SESSION_SYNC_TYPE,
      phase: known ? phase : getRecordingState() === 'recording' ? RECORDING_SESSION_PHASE.recording : RECORDING_SESSION_PHASE.idle })
  }
  return { onToggle, confirmStop, cancelStop, onTail, onLocalFailure, onMessage, acceptGuestRequest,
    dismissGuestRequest, resync, phase: () => phase,
    get awaitingConfirm() { return awaitingConfirm },
    get otherSideUncertain() { return otherSideUncertain },
    get awaitingHost() { return awaitingHost },
    get pendingGuestRequest() { return pendingGuestRequest },
    get changing() { return (connected() && changing) || !!reconciling },
    get buttonMode() { return guestRecordButtonMode({ hostPresent: connected() && !controls(), awaitingHost,
      recordingState: known ? phase : getRecordingState() }) }
  }
}
