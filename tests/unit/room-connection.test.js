import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoomConnection, nextReconnectDelay } from '../../src/lib/room-connection.js'

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
