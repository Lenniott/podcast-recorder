/**
 * Pure helpers for the dBFS level meter.
 *
 * The bar is a VU-style meter: it shows smoothed RMS, the same quantity as
 * the numeric readout and the gradient's dB positions, so color always
 * matches the numbers. Peak is shown only by the separate peak-hold line.
 */

export const METER_MIN = -60
export const METER_MAX = 0

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
