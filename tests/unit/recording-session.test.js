import { describe, it, expect, vi, afterEach } from 'vitest'
import { createRoomConnection } from '../../src/lib/room/room-connection.js'
import { createTakeMarker } from '../../src/lib/recording/take-marker.js'
import {
  RECORDING_SESSION_PHASE,
  RECORDING_SESSION_TYPE,
  createRecordingSession,
  recordingSessionMessage,
  usesSyncedRecordingSession
} from '../../src/lib/recording/recording-session.js'

function makeSocket() {
  const sock = {
    readyState: 0,
    sent: [],
    send(data) { this.sent.push(data) },
    close() {
      if (this.readyState === 3) return
      this.readyState = 3
      this.onclose?.()
    },
    open() {
      this.readyState = 1
      this.onopen?.()
    }
  }
  return sock
}

function setupSession(overrides = {}) {
  let recordingState = 'idle'
  const sent = []
  const local = []
  const session = createRecordingSession({
    send: (payload) => sent.push(payload),
    startLocal: async () => {
      local.push('start')
      recordingState = 'recording'
    },
    stopLocal: async () => {
      local.push('stop')
      recordingState = 'idle'
    },
    getRecordingState: () => recordingState,
    isHost: () => true,
    getWsStatus: () => 'connected',
    ...overrides,
    getRecordingState: overrides.getRecordingState || (() => recordingState)
  })
  return {
    session,
    sent,
    local,
    get recordingState() { return recordingState },
    setRecordingState(next) { recordingState = next }
  }
}

/** Host session + real Take Marker over one send, as the room page wires them. */
function setupSyncedStop(overrides = {}) {
  let recordingState = 'idle'
  let wsStatus = overrides.wsStatus || 'connected'
  const sent = []
  const local = []
  const tones = []
  let takeMarker = null
  const session = createRecordingSession({
    send: (payload) => sent.push(payload),
    startLocal: async () => {
      local.push('start')
      recordingState = 'recording'
    },
    stopLocal: async () => {
      local.push('stop')
      recordingState = 'idle'
    },
    getRecordingState: () => recordingState,
    isHost: () => true,
    getWsStatus: () => wsStatus,
    requestTail: () => takeMarker.requestTail({ synced: true })
  })
  takeMarker = createTakeMarker({
    send: (payload) => sent.push(payload),
    isHost: () => true,
    getWsStatus: () => wsStatus,
    getEngineReady: () => true,
    scheduleTone: (delayMs) => tones.push(delayMs),
    getSamplesWritten: () => 480,
    now: () => Date.now(),
    onTail: (info) => session.onTail(info)
  })
  return {
    session,
    takeMarker,
    sent,
    local,
    tones,
    get recordingState() { return recordingState },
    setWsStatus(next) { wsStatus = next },
    async recordThenStop() {
      await session.onToggle()
      sent.length = 0
      local.length = 0
      await session.onToggle()
    }
  }
}

describe('usesSyncedRecordingSession', () => {
  it('is only for a connected host', () => {
    expect(usesSyncedRecordingSession({ wsStatus: 'connected', isHost: true })).toBe(true)
    expect(usesSyncedRecordingSession({ wsStatus: 'disconnected', isHost: true })).toBe(false)
    expect(usesSyncedRecordingSession({ wsStatus: 'connecting', isHost: true })).toBe(false)
    expect(usesSyncedRecordingSession({ wsStatus: 'connected', isHost: false })).toBe(false)
  })
})

describe('createRecordingSession', () => {
  it('a connected host toggle sends recording_session and starts via the local path', async () => {
    const ctx = setupSession()
    await ctx.session.onToggle()
    expect(ctx.sent).toEqual([recordingSessionMessage(RECORDING_SESSION_PHASE.recording)])
    expect(ctx.local).toEqual(['start'])
    expect(ctx.recordingState).toBe('recording')
  })

  it('a connected host Stop asks to confirm first and neither sends nor stops', async () => {
    const { session, sent, local } = setupSession()
    await session.onToggle()
    sent.length = 0
    local.length = 0
    await session.onToggle()
    expect(session.awaitingConfirm).toBe(true)
    expect(sent).toEqual([])
    expect(local).toEqual([])
  })

  it('cancelStop leaves the take recording: nothing stopped, nothing sent', async () => {
    const ctx = setupSession()
    await ctx.session.onToggle()
    ctx.sent.length = 0
    ctx.local.length = 0
    await ctx.session.onToggle()
    ctx.session.cancelStop()
    expect(ctx.session.awaitingConfirm).toBe(false)
    expect(ctx.session.phase()).toBe(RECORDING_SESSION_PHASE.recording)
    expect(ctx.recordingState).toBe('recording')
    expect(ctx.local).toEqual([])
    expect(ctx.sent).toEqual([])
  })
})

describe('synced Stop with a tail Take Marker', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('confirmStop sends one end-edge take_marker and does not stop in that turn', async () => {
    const ctx = setupSyncedStop()
    await ctx.recordThenStop()
    ctx.session.confirmStop()
    ctx.session.confirmStop()
    expect(ctx.session.awaitingConfirm).toBe(false)
    expect(ctx.sent).toEqual([{ type: 'take_marker', edge: 'end' }])
    expect(ctx.local).toEqual([])
    expect(ctx.session.phase()).toBe(RECORDING_SESSION_PHASE.recording)
  })

  it('the end-edge echo closes the file at the marker instant, then sends idle', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const ctx = setupSyncedStop()
    await ctx.recordThenStop()
    ctx.session.confirmStop()
    ctx.sent.length = 0
    ctx.takeMarker.receive({ triggerAtMs: 12_000, offset: 0, edge: 'end' })
    expect(ctx.tones).toEqual([2000])
    await vi.advanceTimersByTimeAsync(1999)
    expect(ctx.local).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(ctx.local).toEqual(['stop'])
    expect(ctx.sent).toEqual([{ type: 'recording_session', phase: 'idle' }])
    expect(ctx.session.phase()).toBe(RECORDING_SESSION_PHASE.idle)
    expect(ctx.takeMarker.takeReady).toBe(false)
    expect(ctx.takeMarker.startSample).toBe(0)
  })

  it('a second end-edge echo neither schedules nor stops again', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const ctx = setupSyncedStop()
    await ctx.recordThenStop()
    ctx.session.confirmStop()
    ctx.takeMarker.receive({ triggerAtMs: 12_000, offset: 0, edge: 'end' })
    ctx.takeMarker.receive({ triggerAtMs: 12_000, offset: 0, edge: 'end' })
    expect(ctx.tones).toEqual([2000])
    await vi.advanceTimersByTimeAsync(5000)
    expect(ctx.local).toEqual(['stop'])
  })

  it('no echo by 2500ms: the host still closes its file once and is told the other side may be recording', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const ctx = setupSyncedStop()
    await ctx.recordThenStop()
    ctx.session.confirmStop()
    ctx.sent.length = 0
    expect(ctx.session.otherSideUncertain).toBe(false)
    await vi.advanceTimersByTimeAsync(2499)
    expect(ctx.local).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(ctx.local).toEqual(['stop'])
    expect(ctx.sent).toEqual([{ type: 'recording_session', phase: 'idle' }])
    expect(ctx.session.otherSideUncertain).toBe(true)

    ctx.takeMarker.receive({ triggerAtMs: 13_000, offset: 0, edge: 'end' })
    await vi.advanceTimersByTimeAsync(5000)
    expect(ctx.local).toEqual(['stop'])
    expect(ctx.sent).toEqual([{ type: 'recording_session', phase: 'idle' }])
    expect(ctx.session.otherSideUncertain).toBe(true)
  })

  it('the next take starts without the other-side warning from the last one', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const ctx = setupSyncedStop()
    await ctx.recordThenStop()
    ctx.session.confirmStop()
    await vi.advanceTimersByTimeAsync(2500)
    expect(ctx.session.otherSideUncertain).toBe(true)
    ctx.takeMarker.reset()
    await ctx.session.onToggle()
    expect(ctx.recordingState).toBe('recording')
    expect(ctx.session.otherSideUncertain).toBe(false)
  })

  it('socket down: Stop closes the file immediately with no dialog and no marker', async () => {
    const ctx = setupSyncedStop()
    await ctx.session.onToggle()
    ctx.sent.length = 0
    ctx.setWsStatus('disconnected')
    await ctx.session.onToggle()
    expect(ctx.local).toEqual(['start', 'stop'])
    expect(ctx.session.awaitingConfirm).toBe(false)
    expect(ctx.sent.filter((m) => m.type === 'take_marker')).toEqual([])
  })

  it('a connected guest Stop stays local and sends nothing that could stop the host', async () => {
    const { session, sent, local } = setupSession({ isHost: () => false })
    await session.onMessage({ type: RECORDING_SESSION_TYPE, phase: RECORDING_SESSION_PHASE.recording })
    await session.onToggle()
    expect(local).toEqual(['start', 'stop'])
    expect(session.awaitingConfirm).toBe(false)
    expect(sent).toEqual([])
  })

  it('a relayed recording phase starts locally the same way the toggle does', async () => {
    const { session, sent, local } = setupSession({ isHost: () => false })
    await session.onMessage({ type: RECORDING_SESSION_TYPE, phase: RECORDING_SESSION_PHASE.recording })
    expect(local).toEqual(['start'])
    expect(sent).toEqual([])
  })

  it('a relayed idle phase stops locally', async () => {
    const { session, local } = setupSession({ isHost: () => false })
    await session.onMessage({ type: RECORDING_SESSION_TYPE, phase: RECORDING_SESSION_PHASE.recording })
    local.length = 0
    await session.onMessage({ type: RECORDING_SESSION_TYPE, phase: RECORDING_SESSION_PHASE.idle })
    expect(local).toEqual(['stop'])
  })

  it('a connected guest toggle starts only locally and does not send a session message', async () => {
    const { session, sent, local } = setupSession({ isHost: () => false })
    await session.onToggle()
    expect(sent).toEqual([])
    expect(local).toEqual(['start'])
  })

  it('disconnected Start/Stop uses the local path and never sends', async () => {
    const { session, sent, local } = setupSession({ getWsStatus: () => 'disconnected' })
    await session.onToggle()
    expect(sent).toEqual([])
    expect(local).toEqual(['start'])
    await session.onToggle()
    expect(sent).toEqual([])
    expect(local).toEqual(['start', 'stop'])
  })

  it('a failed local start does not claim recording and does not send a session message', async () => {
    let recordingState = 'idle'
    const sent = []
    const session = createRecordingSession({
      send: (payload) => sent.push(payload),
      startLocal: async () => {},
      stopLocal: async () => {},
      getRecordingState: () => recordingState,
      isHost: () => true,
      getWsStatus: () => 'connected'
    })
    await session.onToggle()
    expect(sent).toEqual([])
    expect(recordingState).toBe('idle')
    expect(session.phase()).toBe(RECORDING_SESSION_PHASE.idle)
  })

  it('registerResync re-sends the host session phase after reconnect', async () => {
    const sockets = []
    const conn = createRoomConnection({
      createSocket: () => {
        const sock = makeSocket()
        sockets.push(sock)
        return sock
      },
      onOpen: () => {},
      onMessage: () => {},
      onStatusChange: () => {}
    })

    let recordingState = 'idle'
    const session = createRecordingSession({
      send: (payload) => conn.send(payload),
      startLocal: async () => { recordingState = 'recording' },
      stopLocal: async () => { recordingState = 'idle' },
      getRecordingState: () => recordingState,
      isHost: () => true,
      getWsStatus: () => 'connected'
    })
    conn.registerResync(() => session.resync())

    conn.connect()
    sockets[0].open()
    await session.onToggle()
    expect(sockets[0].sent).toEqual([
      JSON.stringify({ type: RECORDING_SESSION_TYPE, phase: RECORDING_SESSION_PHASE.recording })
    ])

    sockets[0].close()
    conn.connect()
    sockets[1].open()
    expect(sockets[1].sent).toEqual([
      JSON.stringify({ type: RECORDING_SESSION_TYPE, phase: RECORDING_SESSION_PHASE.recording })
    ])
  })

  it('a guest resync does not send a session message', async () => {
    const sent = []
    const session = createRecordingSession({
      send: (payload) => sent.push(payload),
      startLocal: async () => {},
      stopLocal: async () => {},
      getRecordingState: () => 'recording',
      isHost: () => false,
      getWsStatus: () => 'connected'
    })
    await session.onMessage({ type: RECORDING_SESSION_TYPE, phase: RECORDING_SESSION_PHASE.recording })
    sent.length = 0
    session.resync()
    expect(sent).toEqual([])
  })

  it('ignores a non-session message and an unknown phase', async () => {
    const { session, local } = setupSession({ isHost: () => false })
    await session.onMessage({ type: 'clap' })
    await session.onMessage({ type: RECORDING_SESSION_TYPE, phase: 'paused' })
    expect(local).toEqual([])
  })

  it('a host who stops while disconnected after a synced take resyncs idle', async () => {
    let wsStatus = 'connected'
    let recordingState = 'idle'
    const sent = []
    const session = createRecordingSession({
      send: (payload) => sent.push(payload),
      startLocal: async () => { recordingState = 'recording' },
      stopLocal: async () => { recordingState = 'idle' },
      getRecordingState: () => recordingState,
      isHost: () => true,
      getWsStatus: () => wsStatus
    })
    await session.onToggle()
    sent.length = 0
    wsStatus = 'disconnected'
    await session.onToggle()
    expect(recordingState).toBe('idle')
    session.resync()
    expect(sent).toEqual([recordingSessionMessage(RECORDING_SESSION_PHASE.idle)])
  })

  it('a solo disconnected recording does not promote to a synced session on resync', async () => {
    const sent = []
    let recordingState = 'idle'
    const session = createRecordingSession({
      send: (payload) => sent.push(payload),
      startLocal: async () => { recordingState = 'recording' },
      stopLocal: async () => { recordingState = 'idle' },
      getRecordingState: () => recordingState,
      isHost: () => true,
      getWsStatus: () => 'disconnected'
    })
    await session.onToggle()
    expect(recordingState).toBe('recording')
    session.resync()
    expect(sent).toEqual([])
  })
})
