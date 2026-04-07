import { describe, it, expect } from 'vitest'
import {
  buildWavHeader,
  float32ToInt16,
  gainToDb,
  dbToMeterPct
} from '../../src/lib/audio-utils.js'

// ─── buildWavHeader ──────────────────────────────────────────────────────────

describe('buildWavHeader', () => {
  it('returns an ArrayBuffer of exactly 44 bytes', () => {
    const buf = buildWavHeader(0)
    expect(buf.byteLength).toBe(44)
  })

  it('starts with RIFF marker', () => {
    const view = new DataView(buildWavHeader(0))
    const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3))
    expect(riff).toBe('RIFF')
  })

  it('contains WAVE marker at offset 8', () => {
    const view = new DataView(buildWavHeader(0))
    const wave = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11))
    expect(wave).toBe('WAVE')
  })

  it('sets RIFF chunk size = 36 + dataBytes', () => {
    const dataBytes = 1000
    const view = new DataView(buildWavHeader(dataBytes))
    expect(view.getUint32(4, true)).toBe(36 + dataBytes)
  })

  it('sets data sub-chunk size at offset 40', () => {
    const dataBytes = 2048
    const view = new DataView(buildWavHeader(dataBytes))
    expect(view.getUint32(40, true)).toBe(dataBytes)
  })

  it('encodes PCM format (1) at offset 20', () => {
    const view = new DataView(buildWavHeader(0))
    expect(view.getUint16(20, true)).toBe(1)
  })

  it('encodes mono (1 channel) at offset 22', () => {
    const view = new DataView(buildWavHeader(0))
    expect(view.getUint16(22, true)).toBe(1)
  })

  it('encodes 48000 Hz sample rate at offset 24', () => {
    const view = new DataView(buildWavHeader(0))
    expect(view.getUint32(24, true)).toBe(48000)
  })

  it('encodes 16-bit depth at offset 34', () => {
    const view = new DataView(buildWavHeader(0))
    expect(view.getUint16(34, true)).toBe(16)
  })

  it('zero dataBytes gives placeholder-safe header', () => {
    const view = new DataView(buildWavHeader(0))
    expect(view.getUint32(40, true)).toBe(0)
    expect(view.getUint32(4,  true)).toBe(36)
  })
})

// ─── float32ToInt16 ──────────────────────────────────────────────────────────

describe('float32ToInt16', () => {
  it('returns an Int16Array of the same length', () => {
    const f32 = new Float32Array([0, 0.5, -0.5])
    expect(float32ToInt16(f32)).toBeInstanceOf(Int16Array)
    expect(float32ToInt16(f32).length).toBe(3)
  })

  it('converts 0.0 → 0', () => {
    const result = float32ToInt16(new Float32Array([0]))
    expect(result[0]).toBe(0)
  })

  it('converts +1.0 → 32767', () => {
    const result = float32ToInt16(new Float32Array([1.0]))
    expect(result[0]).toBe(32767)
  })

  it('converts -1.0 → -32768', () => {
    const result = float32ToInt16(new Float32Array([-1.0]))
    expect(result[0]).toBe(-32768)
  })

  it('clamps values > 1.0 to 32767', () => {
    const result = float32ToInt16(new Float32Array([2.0]))
    expect(result[0]).toBe(32767)
  })

  it('clamps values < -1.0 to -32768', () => {
    const result = float32ToInt16(new Float32Array([-2.0]))
    expect(result[0]).toBe(-32768)
  })

  it('converts 0.5 to approximately 16383', () => {
    const result = float32ToInt16(new Float32Array([0.5]))
    // 0.5 * 32767 = 16383.5, floor to 16383
    expect(result[0]).toBeCloseTo(16383, 0)
  })

  it('handles empty array', () => {
    const result = float32ToInt16(new Float32Array([]))
    expect(result.length).toBe(0)
  })
})

// ─── gainToDb ────────────────────────────────────────────────────────────────

describe('gainToDb', () => {
  it('returns 0 dB for gain = 1', () => {
    expect(gainToDb(1)).toBeCloseTo(0)
  })

  it('returns -6 dB for gain ≈ 0.5 (half amplitude)', () => {
    expect(gainToDb(0.5)).toBeCloseTo(-6.02, 1)
  })

  it('returns +6 dB for gain = 2', () => {
    expect(gainToDb(2)).toBeCloseTo(6.02, 1)
  })

  it('returns -Infinity for gain = 0', () => {
    expect(gainToDb(0)).toBe(-Infinity)
  })

  it('returns -Infinity for negative gain', () => {
    expect(gainToDb(-1)).toBe(-Infinity)
  })

  it('returns -20 dB for gain = 0.1', () => {
    expect(gainToDb(0.1)).toBeCloseTo(-20, 1)
  })
})

// ─── dbToMeterPct ────────────────────────────────────────────────────────────

describe('dbToMeterPct', () => {
  it('returns 100 at 0 dBFS (max)', () => {
    expect(dbToMeterPct(0)).toBe(100)
  })

  it('returns 0 at -60 dBFS (min)', () => {
    expect(dbToMeterPct(-60)).toBe(0)
  })

  it('returns 50 at the midpoint (-30 dBFS)', () => {
    expect(dbToMeterPct(-30)).toBeCloseTo(50)
  })

  it('clamps to 0 below the min range', () => {
    expect(dbToMeterPct(-120)).toBe(0)
  })

  it('clamps to 100 above 0 dBFS (clipping)', () => {
    expect(dbToMeterPct(6)).toBe(100)
  })

  it('accepts custom min/max range', () => {
    // -20 in a -40 to 0 range → 50%
    expect(dbToMeterPct(-20, -40, 0)).toBeCloseTo(50)
  })
})
