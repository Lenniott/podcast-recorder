/**
 * Pure helpers for the dBFS level meter.
 *
 * The bar is a VU-style meter: it shows smoothed RMS, the same quantity as
 * the numeric readout and the gradient's dB positions, so color always
 * matches the numbers. Peak is shown only by the separate peak-hold line.
 */

export const METER_MIN = -60
export const METER_MAX = 0

/** Tick labels drawn under the bar. Positions come from dbToMeterPct. */
export const METER_TICKS = [-60, -24, -18, -12, -6, -3, 0]

/** Place a dBFS value on the 0–100% bar. Clamped to the visible range. */
export function dbToMeterPct(db) {
  return Math.max(0, Math.min(100, ((db - METER_MIN) / (METER_MAX - METER_MIN)) * 100))
}

/** Numeric readout: a real dB, or an em dash at the floor (not a fake 0.0). */
export function formatMeterReadout(db) {
  return db > METER_MIN ? db.toFixed(1) : '—'
}

/**
 * Colour stops for the full-width meter gradient (not the clipped fill).
 * Green until -24, warms through -18/-12, amber at -6, red from -3 to clip.
 */
export const METER_COLOR_STOPS = [
  { db: -60, color: '#22c55e' },
  { db: -24, color: '#22c55e' },
  { db: -18, color: '#84cc16' },
  { db: -12, color: '#eab308' },
  { db: -6, color: '#f59e0b' },
  { db: -3, color: '#ef4444' },
  { db: 0, color: '#ef4444' },
]

export function meterGradientCss() {
  return METER_COLOR_STOPS.map(({ db, color }) => `${color} ${dbToMeterPct(db)}%`).join(', ')
}

/** Linear amplitude (0-1) → dBFS, floored at METER_MIN. */
export function dbfs(linear) {
  return linear > 0.00001 ? Math.max(METER_MIN, 20 * Math.log10(linear)) : METER_MIN
}

/**
 * One ballistics step for the bar: move prevDb toward targetDb with a fast
 * attack and slow release. Time-based (exponential toward target with time
 * constant tau), so the result depends only on elapsed time — changing how
 * often the worklet posts levels cannot retune the meter.
 */
export function nextFillDb(prevDb, targetDb, dtSec, { attackTau = 0.05, releaseTau = 0.3 } = {}) {
  const tau = targetDb > prevDb ? attackTau : releaseTau
  const alpha = 1 - Math.exp(-Math.max(0, dtSec) / tau)
  return prevDb + (targetDb - prevDb) * alpha
}
