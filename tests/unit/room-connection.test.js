import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoomConnection, nextReconnectDelay } from '../../src/lib/room/room-connection.js'

function makeSocket() {
  const sock = {
    readyState: 0, // CONNECTING
    sent: [],
    send(data) { this.sent.push(data) },
    close() {
      if (this.readyState === 3) return
      this.readyState = 3
      this.onclose?.()
    },
    /** Test-only: simulate a successful handshake. */
    open() {
      this.readyState = 1
      this.onopen?.()
    },
    message(data) {
      this.onmessage?.({ data })
    },
    error() {
      this.onerror?.()
    }
  }
  return sock
}

/**
 * A real WebSocket's close() updates readyState synchronously (to CLOSING,
 * then CLOSED) but only fires onclose asynchronously, later. makeSocket()'s
 * close() fires onclose synchronously, which can't reproduce bugs that only
 * show up in that gap — this variant defers onclose to a microtask instead,
 * matching real browser behavior closely enough to catch them.
 */
function makeAsyncCloseSocket() {
  const sock = makeSocket()
  sock.close = function () {
    if (this.readyState === 3) return
    this.readyState = 3
    queueMicrotask(() => this.onclose?.())
  }
  return sock
}

function setup(overrides = {}) {
  const sockets = []
  const statuses = []
  const messages = []
  const onOpen = vi.fn()
  const conn = createRoomConnection({
    createSocket: () => {
      const sock = makeSocket()
      sockets.push(sock)
      return sock
    },
    onOpen,
    onMessage: (msg) => messages.push(msg),
    onStatusChange: (s) => statuses.push(s),
    ...overrides
  })
  return { conn, sockets, statuses, messages, onOpen }
}

describe('createRoomConnection', () => {
  it('reports a guest lock and stops automatic reconnects after a 4403 close', () => {
    vi.useFakeTimers()
    const locks = []
    const { conn, sockets, statuses } = setup({ onLocked: () => locks.push('locked') })
    conn.connect()
    sockets[0].open()
    sockets[0].readyState = 3
    sockets[0].onclose({ code: 4403 })
    vi.advanceTimersByTime(60_000)
    expect(locks).toEqual(['locked'])
    expect(statuses.at(-1)).toBe('disconnected')
    expect(sockets).toHaveLength(1)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('connect() is idempotent while connecting or connected', () => {
    const { conn, sockets } = setup()
    conn.connect()
    conn.connect()
    expect(sockets).toHaveLength(1)

    sockets[0].open()
    conn.connect()
    expect(sockets).toHaveLength(1)
  })

  it('onMessage gets parsed JSON; malformed JSON is dropped', () => {
    const { conn, sockets, messages } = setup()
    conn.connect()
    sockets[0].open()

    sockets[0].message('{"type":"presence","peers":[]}')
    expect(messages).toEqual([{ type: 'presence', peers: [] }])

    expect(() => sockets[0].message('not-json')).not.toThrow()
    expect(messages).toHaveLength(1)
  })

  it('send() stringifies to the socket, and is a no-op when not connected', () => {
    const { conn, sockets } = setup()
    conn.send({ type: 'join' })
    expect(sockets).toHaveLength(0)

    conn.connect()
    conn.send({ type: 'join' })
    expect(sockets[0].sent).toEqual([])

    sockets[0].open()
    conn.send({ type: 'join', name: 'Ada' })
    expect(sockets[0].sent).toEqual([JSON.stringify({ type: 'join', name: 'Ada' })])
  })

  it('registerResync callbacks run in order after a successful connect', () => {
    const { conn, sockets, onOpen } = setup()
    const order = []
    conn.registerResync(() => order.push('a'))
    conn.registerResync(() => order.push('b'))

    conn.connect()
    sockets[0].open()
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['a', 'b'])
  })

  it('resync callbacks fire again on a second connect after close', () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0) // attempt 0 → 500ms

    const { conn, sockets, onOpen } = setup()
    const order = []
    conn.registerResync(() => order.push('a'))
    conn.registerResync(() => order.push('b'))

    conn.connect()
    sockets[0].open()
    order.length = 0
    onOpen.mockClear()

    sockets[0].close()
    vi.advanceTimersByTime(500)

    expect(sockets).toHaveLength(2)
    sockets[1].open()
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['a', 'b'])
  })

  it('a throwing resync callback does not prevent later ones from running', () => {
    const { conn, sockets } = setup()
    const second = vi.fn()
    conn.registerResync(() => { throw new Error('resync boom') })
    conn.registerResync(second)

    conn.connect()
    expect(() => sockets[0].open()).not.toThrow()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('onStatusChange: connecting before the socket exists, then connected / disconnected', () => {
    const sockets = []
    const statuses = []
    const conn = createRoomConnection({
      createSocket: () => {
        expect(statuses).toEqual(['connecting'])
        const sock = makeSocket()
        sockets.push(sock)
        return sock
      },
      onOpen: () => {},
      onMessage: () => {},
      onStatusChange: (s) => statuses.push(s)
    })

    conn.connect()
    expect(sockets).toHaveLength(1)
    sockets[0].open()
    expect(statuses).toEqual(['connecting', 'connected'])
    sockets[0].close()
    expect(statuses.at(-1)).toBe('disconnected')
  })

  it('onerror reports disconnected', () => {
    const { conn, sockets, statuses } = setup()
    conn.connect()
    sockets[0].error()
    expect(statuses).toContain('disconnected')
  })

  it('increases backoff across failed handshakes and resets it after opening', () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(1)
    const { conn, sockets } = setup()
    conn.connect()
    sockets[0].close()
    vi.advanceTimersByTime(999)
    expect(sockets).toHaveLength(1)
    vi.advanceTimersByTime(1)
    sockets[1].close()
    vi.advanceTimersByTime(1999)
    expect(sockets).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(sockets).toHaveLength(3)
    sockets[2].open()
    sockets[2].close()
    vi.advanceTimersByTime(999)
    expect(sockets).toHaveLength(3)
    vi.advanceTimersByTime(1)
    expect(sockets).toHaveLength(4)
    conn.disconnect()
  })

  it('ignores open, close, and error callbacks from an obsolete socket', () => {
    vi.useFakeTimers()
    const { conn, sockets, statuses, onOpen } = setup()
    const resync = vi.fn()
    conn.registerResync(resync)
    conn.connect()
    const old = sockets[0]
    old.open()
    conn.disconnect()
    conn.connect()
    sockets[1].open()
    statuses.length = 0
    onOpen.mockClear()
    resync.mockClear()

    old.onopen()
    old.onclose()
    old.onerror()
    expect(statuses).toEqual([])
    expect(onOpen).not.toHaveBeenCalled()
    expect(resync).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    conn.send({ type: 'recording', recording: true })
    expect(sockets[1].sent).toEqual(['{"type":"recording","recording":true}'])
    conn.disconnect()
  })

  it('reports disconnected immediately while the socket close callback is still pending', async () => {
    const socket = makeAsyncCloseSocket()
    const statuses = []
    const conn = createRoomConnection({ createSocket: () => socket,
      onStatusChange: status => statuses.push(status) })
    conn.connect()
    socket.open()
    conn.disconnect()
    expect(statuses).toEqual(['connecting', 'connected', 'disconnected'])
    await Promise.resolve()
  })

  it('supports omitted observers and disconnect before any socket exists', () => {
    const socket = makeSocket()
    const conn = createRoomConnection({ createSocket: () => socket })
    expect(() => conn.disconnect()).not.toThrow()
    conn.connect()
    expect(() => socket.open()).not.toThrow()
    expect(() => socket.message('{"type":"presence"}')).not.toThrow()
    conn.disconnect()
    expect(socket.readyState).toBe(3)
  })

  it('disconnect() suppresses a pending reconnect', () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)

    const { conn, sockets } = setup()
    conn.connect()
    sockets[0].open()
    sockets[0].close()
    conn.disconnect()

    vi.advanceTimersByTime(20_000)
    expect(sockets).toHaveLength(1)
  })

  it('disconnect() while connected does not schedule a reconnect', () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)

    const { conn, sockets } = setup()
    conn.connect()
    sockets[0].open()
    conn.disconnect()

    vi.advanceTimersByTime(20_000)
    expect(sockets).toHaveLength(1)
  })

  it('connect() right after disconnect() opens a new socket, even before the old close() has actually resolved', async () => {
    // Regression: a real WebSocket.close() only fires onclose asynchronously.
    // If disconnect() doesn't update status itself, a connect() called in
    // that gap sees a stale 'connected'/'connecting' status and silently
    // no-ops — nothing ever reconnects.
    const sockets = []
    const conn = createRoomConnection({
      createSocket: () => {
        const sock = makeAsyncCloseSocket()
        sockets.push(sock)
        return sock
      },
      onOpen: () => {},
      onMessage: () => {},
      onStatusChange: () => {}
    })

    conn.connect()
    sockets[0].open()
    conn.disconnect()
    conn.connect() // synchronously right after — the old socket's onclose hasn't fired yet

    expect(sockets).toHaveLength(2)

    // Let the deferred onclose from the first socket actually fire, and
    // confirm it doesn't retroactively mess with the new connection.
    await Promise.resolve()
    expect(sockets).toHaveLength(2)
  })
})

describe('nextReconnectDelay', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('grows with attempt and caps at 15000 before jitter', () => {
    vi.spyOn(Math, 'random').mockReturnValue(1) // jitter factor 1.0 → delay === capped exponential
    expect(nextReconnectDelay(0)).toBe(1000)
    expect(nextReconnectDelay(1)).toBe(2000)
    expect(nextReconnectDelay(2)).toBe(4000)
    expect(nextReconnectDelay(3)).toBe(8000)
    expect(nextReconnectDelay(4)).toBe(15000)
    expect(nextReconnectDelay(10)).toBe(15000)
  })

  it('applies jitter in [0.5, 1.0] of the capped exponential', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0) // factor 0.5
    expect(nextReconnectDelay(0)).toBe(500)
    expect(nextReconnectDelay(4)).toBe(7500)
  })

  it('is not a constant for the same attempt (jitter varies)', () => {
    const random = vi.spyOn(Math, 'random')
    random.mockReturnValueOnce(0)
    random.mockReturnValueOnce(1)
    expect(nextReconnectDelay(2)).not.toBe(nextReconnectDelay(2))
  })
})
