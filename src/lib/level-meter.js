import { METER_MIN, dbfs, nextFillDb } from './meter.js'

export function createLevelMeter({
  now = () => globalThis.performance?.now?.() ?? Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onState = () => {}
} = {}) {
  let dbLevel = METER_MIN
  let meterFillDb = METER_MIN
  let lastLevelAt = 0
  let peakHoldDb = METER_MIN
  let peakHoldTimer = null
  let isClipping = false
  let clipTimer = null

  function emit() {
    onState({ dbLevel, meterFillDb, peakHoldDb, isClipping })
  }

  function handleLevel(rms, peak) {
    dbLevel = dbfs(rms)
    const peakDbNow = dbfs(peak)

    const t = now()
    const dtSec = lastLevelAt ? Math.min(0.25, (t - lastLevelAt) / 1000) : 0.05
    lastLevelAt = t
    meterFillDb = nextFillDb(meterFillDb, dbLevel, dtSec)

    if (peakDbNow > peakHoldDb) {
      peakHoldDb = peakDbNow
      clearTimer(peakHoldTimer)
      peakHoldTimer = setTimer(() => {
        peakHoldDb = METER_MIN
        emit()
      }, 2000)
    }

    if (peakDbNow >= -0.5) {
      isClipping = true
      clearTimer(clipTimer)
      clipTimer = setTimer(() => {
        isClipping = false
        emit()
      }, 2000)
    }

    emit()
  }

  function close() {
    clearTimer(peakHoldTimer)
    clearTimer(clipTimer)
  }

  return {
    handleLevel,
    close,
    get state() {
      return { dbLevel, meterFillDb, peakHoldDb, isClipping }
    }
  }
}
