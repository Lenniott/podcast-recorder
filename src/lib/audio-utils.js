/**
 * Pure audio utility functions — no browser APIs, fully testable in Node.
 */

const DEFAULT_SAMPLE_RATE = 48000
const CHANNELS    = 1
const BIT_DEPTH   = 16

/**
 * Build a standard 44-byte PCM WAV header.
 * Pass dataBytes=0 as a placeholder at recording start,
 * then seek(0) and rewrite with the real count at the end.
 */
export function buildWavHeader(dataBytes, sampleRate = DEFAULT_SAMPLE_RATE) {
  const sr = Number.isFinite(sampleRate) && sampleRate > 0
    ? Math.round(sampleRate)
    : DEFAULT_SAMPLE_RATE
  const byteRate   = sr * CHANNELS * (BIT_DEPTH / 8)
  const blockAlign = CHANNELS * (BIT_DEPTH / 8)

  const buf  = new ArrayBuffer(44)
  const view = new DataView(buf)
  const str  = (off, s) => [...s].forEach((c, i) => view.setUint8(off + i, c.charCodeAt(0)))

  str(0,  'RIFF')
  view.setUint32( 4, 36 + dataBytes, true)
  str(8,  'WAVE')
  str(12, 'fmt ')
  view.setUint32(16, 16, true)          // chunk size (PCM)
  view.setUint16(20,  1, true)          // format: PCM
  view.setUint16(22, CHANNELS, true)
  view.setUint32(24, sr, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, BIT_DEPTH, true)
  str(36, 'data')
  view.setUint32(40, dataBytes, true)

  return buf
}

/**
 * Convert a Float32Array of PCM samples (-1..1) to Int16Array.
 * Clamps correctly at the extremes.
 */
export function float32ToInt16(f32) {
  const i16 = new Int16Array(f32.length)
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]))
    i16[i] = s < 0 ? s * 32768 : s * 32767
  }
  return i16
}

/**
 * Convert a linear gain multiplier to dBFS.
 */
export function gainToDb(gain) {
  return gain > 0 ? 20 * Math.log10(gain) : -Infinity
}

/**
 * Map a dBFS value to a 0–100 meter percentage.
 * Range: minDb (silence) → maxDb (full scale).
 */
export function dbToMeterPct(db, minDb = -60, maxDb = 0) {
  return Math.max(0, Math.min(100, ((db - minDb) / (maxDb - minDb)) * 100))
}
