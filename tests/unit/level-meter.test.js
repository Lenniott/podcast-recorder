import { describe, it, expect, afterEach, vi } from 'vitest'
import { createLevelMeter } from '../../src/lib/recording/level-meter.js'
import { METER_MIN } from '../../src/lib/recording/meter.js'

describe('createLevelMeter', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('uses RMS for the numeric level and smoothed fill', () => {
    let t = 1000
    const states = []
    const meter = createLevelMeter({
      now: () => t,
      onState: (state) => states.push(state)
    })

    meter.handleLevel(0.1, 0.2)
    expect(states.at(-1).dbLevel).toBeCloseTo(-20, 5)
    expect(states.at(-1).meterFillDb).toBeGreaterThan(METER_MIN)
    expect(states.at(-1).meterFillDb).toBeLessThan(-20)

    t += 100
    meter.handleLevel(0.01, 0.02)
    expect(states.at(-1).dbLevel).toBeCloseTo(-40, 5)
  })

  it('uses peak for the hold marker and resets it after 2 seconds', () => {
    vi.useFakeTimers()
    const states = []
    const meter = createLevelMeter({ onState: (state) => states.push(state) })

    meter.handleLevel(0.01, 0.5)
    expect(states.at(-1).peakHoldDb).toBeCloseTo(-6.0206, 3)

    vi.advanceTimersByTime(1999)
    expect(states.at(-1).peakHoldDb).toBeCloseTo(-6.0206, 3)

    vi.advanceTimersByTime(1)
    expect(states.at(-1).peakHoldDb).toBe(METER_MIN)
  })

  it('reports clipping for near-full-scale peaks and clears it after 2 seconds', () => {
    vi.useFakeTimers()
    const states = []
    const meter = createLevelMeter({ onState: (state) => states.push(state) })

    meter.handleLevel(0.1, 1)
    expect(states.at(-1).isClipping).toBe(true)

    vi.advanceTimersByTime(2000)
    expect(states.at(-1).isClipping).toBe(false)
  })

  it('close() cancels pending reset timers', () => {
    vi.useFakeTimers()
    const states = []
    const meter = createLevelMeter({ onState: (state) => states.push(state) })

    meter.handleLevel(0.1, 1)
    const emittedBeforeClose = states.length
    meter.close()
    vi.advanceTimersByTime(2000)

    expect(states).toHaveLength(emittedBeforeClose)
  })
})
