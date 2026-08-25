import { describe, it, expect, afterEach, vi } from 'vitest'
import { createClockSync } from '../../src/lib/clock-sync.js'

describe('createClockSync', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('offset stays 0 until 3 pongs land', () => {
    const sent = []
    const clock = createClockSync({ send: (msg) => sent.push(msg) })
    expect(clock.offset).toBe(0)

    clock.syncClock()
    clock.handlePong({ type: 'pong', seq: sent[0].seq, serverReceivedAt: 1000 })
    expect(clock.offset).toBe(0)
    clock.handlePong({ type: 'pong', seq: sent[1].seq, serverReceivedAt: 1000 })
    expect(clock.offset).toBe(0)
  })

  it('syncClock() sends 3 pings with distinct increasing seq', () => {
    const sent = []
    const clock = createClockSync({ send: (msg) => sent.push(msg) })
    clock.syncClock()
    expect(sent).toHaveLength(3)
    expect(sent.every((m) => m.type === 'ping')).toBe(true)
    expect(sent.map((m) => m.seq)).toEqual([1, 2, 3])
    expect(sent.every((m) => Number.isFinite(m.sentAt))).toBe(true)
  })

  it('offset becomes the mean of the 3 round-trip samples once all 3 pongs land', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000)
    const sent = []
    const clock = createClockSync({ send: (msg) => sent.push(msg) })
    clock.syncClock() // all 3 pings sentAt = 1000

    // sample_i = serverReceivedAt - (sentAt + Date.now()) / 2, with Date.now() still 1000
    clock.handlePong({ seq: sent[0].seq, serverReceivedAt: 1100 }) // sample = 1100 - 1000 = 100
    clock.handlePong({ seq: sent[1].seq, serverReceivedAt: 1200 }) // sample = 200
    clock.handlePong({ seq: sent[2].seq, serverReceivedAt: 1300 }) // sample = 300
    expect(clock.offset).toBeCloseTo(200, 5) // mean(100, 200, 300)
  })

  it('a stray or duplicate seq is ignored and does not affect the offset', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000)
    const sent = []
    const clock = createClockSync({ send: (msg) => sent.push(msg) })
    clock.syncClock()

    clock.handlePong({ seq: 999, serverReceivedAt: 5000 }) // unknown seq, ignored
    clock.handlePong({ seq: sent[0].seq, serverReceivedAt: 1100 })
    clock.handlePong({ seq: sent[0].seq, serverReceivedAt: 9999 }) // duplicate, already deleted, ignored
    clock.handlePong({ seq: sent[1].seq, serverReceivedAt: 1100 })
    clock.handlePong({ seq: sent[2].seq, serverReceivedAt: 1100 })
    expect(clock.offset).toBeCloseTo(100, 5)
  })

  it('a fresh syncClock() burst resets the sample window', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000)
    const sent = []
    const clock = createClockSync({ send: (msg) => sent.push(msg) })
    clock.syncClock()
    clock.handlePong({ seq: sent[0].seq, serverReceivedAt: 1100 })
    clock.handlePong({ seq: sent[1].seq, serverReceivedAt: 1100 })
    clock.handlePong({ seq: sent[2].seq, serverReceivedAt: 1100 })
    expect(clock.offset).toBeCloseTo(100, 5)

    sent.length = 0
    clock.syncClock()
    clock.handlePong({ seq: sent[0].seq, serverReceivedAt: 1500 })
    clock.handlePong({ seq: sent[1].seq, serverReceivedAt: 1500 })
    // Only 2 of 3 new pongs landed — offset should still reflect the last
    // *completed* window (the old one), not a half-updated average.
    expect(clock.offset).toBeCloseTo(100, 5)
    clock.handlePong({ seq: sent[2].seq, serverReceivedAt: 1500 })
    expect(clock.offset).toBeCloseTo(500, 5)
  })
})
