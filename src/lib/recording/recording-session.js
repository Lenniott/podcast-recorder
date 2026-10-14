/**
 * Room-level Synced Recording Session: one host-authored WebSocket message
 * starts or stops every peer's *existing* local recording path. The session
 * is optional dressing over local recording — with the room socket down,
 * Start/Stop still writes a real file and never waits on a round-trip.
 */

export const RECORDING_SESSION_TYPE = 'recording_session'

export const RECORDING_SESSION_PHASE = {
  idle: 'idle',
  recording: 'recording'
}

export const RECORDING_SESSION_HOST_ONLY =
  'Only the host can control the recording session.'

export const STOP_BOTH_CONFIRM =
  'Stop recording for both of you? This ends the take.'

export const OTHER_SIDE_UNCERTAIN =
  'The other side may still be recording.'

export function recordingSessionMessage(phase) {
  return { type: RECORDING_SESSION_TYPE, phase }
}

export function usesSyncedRecordingSession({ wsStatus, isHost }) {
  return wsStatus === 'connected' && !!isHost
}

export function isRecordingSessionPhase(phase) {
  return phase === RECORDING_SESSION_PHASE.idle || phase === RECORDING_SESSION_PHASE.recording
}

export function createRecordingSession({
  send,
  startLocal,
  stopLocal,
  getRecordingState,
  isHost,
  getWsStatus,
  requestTail
}) {
  let phase = RECORDING_SESSION_PHASE.idle
  let known = false
  let awaitingConfirm = false
  let otherSideUncertain = false

  function phaseFn() {
    return phase
  }

  async function applyRemote(nextPhase) {
    if (!isRecordingSessionPhase(nextPhase)) return
    known = true
    phase = nextPhase
    const state = getRecordingState()
    if (nextPhase === RECORDING_SESSION_PHASE.recording && state === 'idle') {
      await startLocal()
      if (getRecordingState() !== 'recording') phase = RECORDING_SESSION_PHASE.idle
      return
    }
    if (nextPhase === RECORDING_SESSION_PHASE.idle && state === 'recording') {
      await stopLocal()
    }
  }

  async function onToggle() {
    const state = getRecordingState()
    const synced = usesSyncedRecordingSession({
      wsStatus: getWsStatus(),
      isHost: isHost()
    })

    if (state === 'idle') {
      await startLocal()
      if (getRecordingState() !== 'recording') return
      otherSideUncertain = false
      if (synced) {
        known = true
        phase = RECORDING_SESSION_PHASE.recording
        send(recordingSessionMessage(RECORDING_SESSION_PHASE.recording))
      }
      return
    }

    if (state === 'recording') {
      if (synced) {
        awaitingConfirm = true
        return
      }
      if (known) {
        phase = RECORDING_SESSION_PHASE.idle
      }
      await stopLocal()
    }
  }

  function confirmStop() {
    if (!awaitingConfirm) return
    awaitingConfirm = false
    requestTail?.()
  }

  function cancelStop() {
    awaitingConfirm = false
  }

  async function onTail({ uncertain = false } = {}) {
    phase = RECORDING_SESSION_PHASE.idle
    if (uncertain) otherSideUncertain = true
    try {
      await stopLocal()
    } finally {
      if (isHost()) {
        known = true
        send(recordingSessionMessage(RECORDING_SESSION_PHASE.idle))
      }
    }
  }

  async function onMessage(msg) {
    if (!msg || msg.type !== RECORDING_SESSION_TYPE) return
    await applyRemote(msg.phase)
  }

  function resync() {
    if (!isHost() || !known) return
    send(recordingSessionMessage(phase))
  }

  return {
    onToggle,
    confirmStop,
    cancelStop,
    onTail,
    onMessage,
    resync,
    phase: phaseFn,
    get awaitingConfirm() { return awaitingConfirm },
    get otherSideUncertain() { return otherSideUncertain }
  }
}
