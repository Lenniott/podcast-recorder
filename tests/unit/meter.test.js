import { describe, it, expect } from 'vitest'
import { METER_MIN, dbfs, nextFillDb, dbToMeterPct, formatMeterReadout, METER_COLOR_STOPS } from '../../src/lib/meter.js'

describe('dbfs', () => {
  it('converts linear amplitude to dBFS', () => {
    expect(dbfs(1)).toBeCloseTo(0, 5)
    expect(dbfs(0.1)).toBeCloseTo(-20, 5)
    expect(dbfs(0.01)).toBeCloseTo(-40, 5)
  })

  it('floors silence and near-silence at METER_MIN', () => {
    expect(dbfs(0)).toBe(METER_MIN)
    expect(dbfs(0.000001)).toBe(METER_MIN)
    expect(dbfs(0.0005)).toBe(METER_MIN) // -66 dB, below the floor
  })
})

describe('nextFillDb ballistics', () => {
  it('rises toward a louder target and falls toward a quieter one', () => {
    expect(nextFillDb(-60, -20, 0.05)).toBeGreaterThan(-60)
    expect(nextFillDb(-20, -60, 0.05)).toBeLessThan(-20)
  })

  it('attack is faster than release', () => {
    const rise = nextFillDb(-40, -20, 0.05) - -40   // toward louder
    const fall = -20 - nextFillDb(-20, -40, 0.05)   // toward quieter
    expect(rise).toBeGreaterThan(fall)
  })

  it('is rate-independent: many small steps equal one big step', () => {
    // The original bug: per-message smoothing constants meant the worklet's
    // post rate silently retuned the meter (375 msg/s ≈ no smoothing at all).
    let fine = -60
    for (let i = 0; i < 100; i++) fine = nextFillDb(fine, -20, 0.001)
    const coarse = nextFillDb(-60, -20, 0.1)
    expect(fine).toBeCloseTo(coarse, 6)
  })

  it('release decays to the floor within ~2s', () => {
    let db = -20
    for (let t = 0; t < 2; t += 0.043) db = nextFillDb(db, METER_MIN, 0.043)
    expect(db).toBeLessThan(METER_MIN + 1)
  })

  it('converges to the target and stays there', () => {
    let db = -60
    for (let i = 0; i < 50; i++) db = nextFillDb(db, -25, 0.043)
    expect(db).toBeCloseTo(-25, 3)
  })
})

describe('dbToMeterPct', () => {
  // Linear-dB bar from METER_MIN (-60) to 0. Literals are the spec — if
  // someone restyles tick `left:` by eye, the fill/peak and labels diverge.
  it('maps the floor to 0% and 0 dBFS to 100%', () => {
    expect(dbToMeterPct(-60)).toBe(0)
    expect(dbToMeterPct(0)).toBe(100)
  })

  it('places the labelled ticks at their true dB positions', () => {
    expect(dbToMeterPct(-24)).toBe(60)
    expect(dbToMeterPct(-18)).toBe(70)
    expect(dbToMeterPct(-12)).toBe(80)
    expect(dbToMeterPct(-6)).toBe(90)
    expect(dbToMeterPct(-3)).toBe(95)
  })
})

describe('formatMeterReadout', () => {
  it('does not invent a number when the meter is at the floor', () => {
    expect(formatMeterReadout(METER_MIN)).toBe('—')
    expect(formatMeterReadout(-16.2)).toBe('-16.2')
  })
})

describe('METER_COLOR_STOPS', () => {
  it('keeps red off the bar until -3 dBFS', () => {
    const firstRedDb = Math.min(
      ...METER_COLOR_STOPS.filter((s) => s.color === '#ef4444').map((s) => s.db),
    )
    expect(firstRedDb).toBe(-3)
    expect(dbToMeterPct(-3)).toBe(95)
  })

  it('starts warming before -12 so -18 and -12 are not the same green', () => {
    const at = (db) => METER_COLOR_STOPS.find((s) => s.db === db)?.color
    expect(at(-24)).toBe('#22c55e')
    expect(at(-18)).not.toBe(at(-24))
    expect(at(-12)).not.toBe(at(-18))
  })
})
