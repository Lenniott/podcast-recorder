import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRecordingSession, createRoomRecordingState } from '../../src/lib/recording/synced-recording-session.js'
import { createTakeMarker } from '../../src/lib/recording/take-marker.js'

afterEach(() => vi.useRealTimers())

// Exercise recording control across its real server/client seam. Only local
// capture and transport are replaced; neither side invents the protocol.
function roomFixture() {
  const clients = new Map()
  const messages = []
  const pending = []
  let peers = []
  const deliver = (client, message) => pending.push(client.session.onMessage(message))
  const room = createRoomRecordingState({
    publish: message => { for (const client of clients.values()) deliver(client, message) },
    reply: (id, message) => { if (clients.has(id)) deliver(clients.get(id), message) }
  })
  function presence() {
    const message = room.presence(peers)
    if (message) for (const client of clients.values()) deliver(client, message)
  }
  function add(id, isHost = false, options = {}) {
    let state = 'idle'
    let wsStatus = 'connected'
    let marker
    const startLocal = vi.fn(async () => {
      await options.beforeStart?.()
      if (!options.failStart) state = 'recording'
    })
    const stopLocal = vi.fn(async () => { state = 'idle' })
    const send = message => {
      messages.push({ id, ...message })
      room.receive(id, message)
    }
    const session = createRecordingSession({ send, startLocal, stopLocal,
      getRecordingState: () => state, isHost: () => isHost,
      getWsStatus: () => wsStatus,
      isHostPresent: () => peers.some(peer => peer.role === 'host' && peer.clientId !== id),
      requestTail: () => marker.requestTail({ synced: true }) })
    marker = createTakeMarker({ send, isHost: () => isHost, getWsStatus: () => wsStatus,
      getEngineReady: () => true, getSamplesWritten: () => 480,
      onTail: info => pending.push(session.onTail(info)) })
    const client = { session, marker, startLocal, stopLocal, get state() { return state },
      disconnect() { wsStatus = 'disconnected' }, reconnect() { wsStatus = 'connected'; session.resync() } }
    clients.set(id, client)
    peers = [...peers, { clientId: id, name: id, role: isHost ? 'host' : 'guest' }]
    presence()
    session.resync()
    return client
  }
  return { add, room, messages,
    async flush() { while (pending.length) await Promise.all(pending.splice(0)) },
    remove(id) { clients.delete(id); peers = peers.filter(peer => peer.clientId !== id); presence() }
  }
}

describe('room-owned recording control', () => {
  it('host start changes the room and starts both existing recording paths once', async () => {
    const room = roomFixture()
    const host = room.add('host', true)
    const guest = room.add('guest')
    await room.flush()
    await host.session.onToggle()
    await room.flush()
    expect(host.state).toBe('recording')
    expect(guest.state).toBe('recording')
    expect(host.startLocal).toHaveBeenCalledOnce()
    expect(guest.startLocal).toHaveBeenCalledOnce()
    expect(host.session.phase()).toBe('recording')
    expect(guest.session.phase()).toBe('recording')
  })

  it('a controller waits for room acknowledgement instead of starting optimistically', async () => {
    const startLocal = vi.fn()
    const send = vi.fn()
    const session = createRecordingSession({ send, startLocal, stopLocal: vi.fn(),
      getRecordingState: () => 'idle', isHost: () => true, getWsStatus: () => 'connected' })
    await session.onToggle()
    expect(send).toHaveBeenCalledExactlyOnceWith({ type: 'recording_session', phase: 'recording' })
    expect(startLocal).not.toHaveBeenCalled()
    expect(session.changing).toBe(true)
  })

  it('losing the socket before acknowledgement does not lock out offline recording', async () => {
    let status = 'connected'
    let state = 'idle'
    const startLocal = vi.fn(async () => { state = 'recording' })
    const session = createRecordingSession({ send: vi.fn(), startLocal, stopLocal: vi.fn(),
      getRecordingState: () => state, isHost: () => true, getWsStatus: () => status })
    await session.onToggle()
    status = 'disconnected'
    expect(session.changing).toBe(false)
    await session.onToggle()
    expect(startLocal).toHaveBeenCalledOnce()
    expect(state).toBe('recording')
  })

  it('guest start with a host present waits for approval; duplicate clicks create no extra request', async () => {
    const room = roomFixture()
    const host = room.add('host', true)
    const guest = room.add('guest')
    await room.flush()
    await guest.session.onToggle()
    await guest.session.onToggle()
    await room.flush()
    expect(guest.state).toBe('idle')
    expect(host.state).toBe('idle')
    expect(guest.session.buttonMode).toBe('waiting-start')
    expect(host.session.pendingGuestRequest).toEqual({ action: 'start', clientId: 'guest', from: 'guest' })
    expect(room.messages.filter(message => message.type === 'recording_session_request')).toHaveLength(1)
    await host.session.acceptGuestRequest()
    await room.flush()
    expect(host.state).toBe('recording')
    expect(guest.state).toBe('recording')
    expect(guest.session.buttonMode).toBe('request-stop')
  })

  it('decline returns the guest to Request Record and never starts capture', async () => {
    const room = roomFixture()
    const host = room.add('host', true)
    const guest = room.add('guest')
    await room.flush()
    await guest.session.onToggle()
    await room.flush()
    host.session.dismissGuestRequest()
    await room.flush()
    expect(guest.session.buttonMode).toBe('request-start')
    expect(host.session.pendingGuestRequest).toBeNull()
    expect(guest.startLocal).not.toHaveBeenCalled()
    expect(host.startLocal).not.toHaveBeenCalled()
  })

  it('a pending start applies automatically when the host leaves', async () => {
    const room = roomFixture()
    room.add('host', true)
    const guest = room.add('guest')
    await room.flush()
    await guest.session.onToggle()
    await room.flush()
    room.remove('host')
    await room.flush()
    expect(guest.state).toBe('recording')
    expect(guest.session.awaitingHost).toBeNull()
    expect(guest.session.buttonMode).toBeNull()
    const returningHost = room.add('host', true)
    await room.flush()
    expect(returningHost.state).toBe('recording')
    expect(returningHost.session.pendingGuestRequest).toBeNull()
  })

  it('a guest alone controls the room, and the joining host inherits its active phase', async () => {
    const room = roomFixture()
    const guest = room.add('guest')
    await room.flush()
    await guest.session.onToggle()
    await room.flush()
    const host = room.add('host', true)
    await room.flush()
    expect(host.state).toBe('recording')
    expect(guest.startLocal).toHaveBeenCalledOnce()
    expect(guest.session.buttonMode).toBe('request-stop')
  })

  it('pending requests survive reconnect and are cleared by the host decision', async () => {
    const room = roomFixture()
    room.add('host', true)
    const guest = room.add('guest')
    await room.flush()
    await guest.session.onToggle()
    await room.flush()
    const host = room.add('host', true)
    await room.flush()
    expect(host.session.pendingGuestRequest?.action).toBe('start')
    guest.session.resync()
    await room.flush()
    expect(guest.session.awaitingHost).toBe('start')
    host.session.dismissGuestRequest()
    await room.flush()
    expect(guest.session.awaitingHost).toBeNull()
  })

  it('reconnect reads current room truth instead of overwriting it with an old phase', async () => {
    const room = roomFixture()
    const host = room.add('host', true)
    const guest = room.add('guest')
    await room.flush()
    host.disconnect()
    room.remove('host')
    await room.flush()
    await guest.session.onToggle()
    await room.flush()
    const returningHost = room.add('host', true)
    await room.flush()
    expect(returningHost.state).toBe('recording')
    returningHost.session.resync()
    await room.flush()
    expect(guest.state).toBe('recording')
    expect(guest.startLocal).toHaveBeenCalledOnce()
  })

  it('a failed local start does not rewrite the shared phase or retry on every replay', async () => {
    const room = roomFixture()
    const host = room.add('host', true, { failStart: true })
    const guest = room.add('guest')
    await room.flush()
    await host.session.onToggle()
    await room.flush()
    host.session.resync()
    await room.flush()
    expect(host.state).toBe('idle')
    expect(host.session.phase()).toBe('recording')
    expect(guest.state).toBe('recording')
    expect(host.startLocal).toHaveBeenCalledOnce()
  })

  it('a permanent host save failure stops both recorders through the room state', async () => {
    const room = roomFixture()
    const host = room.add('host', true)
    const guest = room.add('guest')
    await room.flush()
    await host.session.onToggle()
    await room.flush()
    await host.session.onLocalFailure()
    await room.flush()
    expect(host.state).toBe('idle')
    expect(guest.state).toBe('idle')
    expect(host.stopLocal).toHaveBeenCalledOnce()
    expect(guest.stopLocal).toHaveBeenCalledOnce()
    expect(host.session.phase()).toBe('idle')
  })

  it('a permanent guest save failure stops locally without bypassing host control', async () => {
    const room = roomFixture()
    const host = room.add('host', true)
    const guest = room.add('guest')
    await room.flush()
    await host.session.onToggle()
    await room.flush()
    await guest.session.onLocalFailure()
    await room.flush()
    expect(guest.state).toBe('idle')
    expect(host.state).toBe('recording')
    expect(host.session.pendingGuestRequest?.action).toBe('stop')
    expect(guest.session.buttonMode).toBe('waiting-stop')
  })

  it('serializes duplicate start and a stop arriving while opening the local recording', async () => {
    let release
    let state = 'idle'
    const start = vi.fn(async () => { await new Promise(resolve => { release = resolve }); state = 'recording' })
    const stop = vi.fn(async () => { state = 'idle' })
    const session = createRecordingSession({ send: vi.fn(), startLocal: start, stopLocal: stop,
      getRecordingState: () => state, isHost: () => false, getWsStatus: () => 'connected' })
    const first = session.onMessage({ type: 'recording_session', phase: 'recording' })
    await Promise.resolve()
    const duplicate = session.onMessage({ type: 'recording_session', phase: 'recording' })
    const stopped = session.onMessage({ type: 'recording_session', phase: 'idle' })
    release()
    await Promise.all([first, duplicate, stopped])
    expect(start).toHaveBeenCalledOnce()
    expect(stop).toHaveBeenCalledOnce()
    expect(state).toBe('idle')
  })

  it('cancels a start waiting on browser audio when the room stops, without starting a file later', async () => {
    const onIssue = vi.fn()
    let opened = false
    const session = createRecordingSession({ send: vi.fn(), stopLocal: vi.fn(),
      startLocal: async ({ signal }) => {
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
        if (!signal.aborted) opened = true
      },
      getRecordingState: () => 'idle', isHost: () => false,
      getWsStatus: () => 'connected', onIssue })
    const starting = session.onMessage({ type: 'recording_session', phase: 'recording' })
    await Promise.resolve()
    const stopping = session.onMessage({ type: 'recording_session', phase: 'idle' })
    await Promise.all([starting, stopping])
    expect(onIssue).not.toHaveBeenCalled()
    expect(opened).toBe(false)
    expect(session.changing).toBe(false)
  })

  it('offline capture still saves locally and publishes an explicit offline change after reconnect', async () => {
    const room = roomFixture()
    const host = room.add('host', true)
    await room.flush()
    host.disconnect()
    await host.session.onToggle()
    expect(host.state).toBe('recording')
    host.reconnect()
    await room.flush()
    const guest = room.add('guest')
    await room.flush()
    expect(guest.state).toBe('recording')
  })
})

describe('room stop and the existing tail marker', () => {
  it('host cancel leaves both recording; confirmation stops at the tail, not before', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10000)
    const room = roomFixture()
    const host = room.add('host', true)
    const guest = room.add('guest')
    await room.flush()
    await host.session.onToggle()
    await room.flush()
    await host.session.onToggle()
    expect(host.session.awaitingConfirm).toBe(true)
    host.session.cancelStop()
    expect(host.state).toBe('recording')
    await host.session.onToggle()
    host.session.confirmStop()
    host.marker.receive({ triggerAtMs: 12000, offset: 0, edge: 'end' })
    guest.marker.receive({ triggerAtMs: 12000, offset: 0, edge: 'end' })
    await vi.advanceTimersByTimeAsync(1999)
    expect(host.state).toBe('recording')
    await vi.advanceTimersByTimeAsync(1)
    await room.flush()
    expect(host.state).toBe('idle')
    expect(guest.state).toBe('idle')
    expect(host.stopLocal).toHaveBeenCalledOnce()
    expect(guest.stopLocal).toHaveBeenCalledOnce()
  })

  it('accepting a stop request is confirmation and a lost echo still finalizes the host', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10000)
    const room = roomFixture()
    const host = room.add('host', true)
    const guest = room.add('guest')
    await room.flush()
    await host.session.onToggle()
    await room.flush()
    await guest.session.onToggle()
    await room.flush()
    expect(guest.session.buttonMode).toBe('waiting-stop')
    await host.session.acceptGuestRequest()
    expect(host.session.awaitingConfirm).toBe(false)
    expect(room.messages).toContainEqual({ id: 'host', type: 'take_marker', edge: 'end' })
    await vi.advanceTimersByTimeAsync(2500)
    await room.flush()
    expect(host.state).toBe('idle')
    expect(guest.state).toBe('idle')
    expect(host.session.otherSideUncertain).toBe(true)
  })

  it('a pending stop takes effect when its host leaves', async () => {
    const room = roomFixture()
    const host = room.add('host', true)
    const guest = room.add('guest')
    await room.flush()
    await host.session.onToggle()
    await room.flush()
    await guest.session.onToggle()
    await room.flush()
    room.remove('host')
    await room.flush()
    expect(guest.state).toBe('idle')
    expect(guest.session.awaitingHost).toBeNull()
  })
})
