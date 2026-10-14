/**
 * Take Marker — clap tone + take-boundary flip at one clock-offset-corrected
 * instant (`triggerAtMs`). Used at take start (after both Check Turns pass)
 * and at take stop: the tail (`edge: 'end'`) goes through the same
 * `scheduleTakeMarker`, and its boundary is where both files close.
 *
 * The WAV is never truncated: audio written before the start marker stays on
 * disk; `presentTake` is how callers exclude it from "the take."
 */

export const TAKE_MARKER_TYPE = 'take_marker'

export const TAKE_MARKER_LEAD_MS = 3000

/** Server lead for the end-edge (tail) marker: both files close this long after confirm. */
export const TAKE_MARKER_TAIL_LEAD_MS = 2000

/** The host closes its own file this long after confirm even if the end-edge echo never came back. */
export const TAKE_MARKER_TAIL_FALLBACK_MS = 2500

export const TAKE_MARKER_EDGE_END = 'end'

export function takeMarkerMessage({ edge } = {}) {
  return edge === TAKE_MARKER_EDGE_END
    ? { type: TAKE_MARKER_TYPE, edge: TAKE_MARKER_EDGE_END }
    : { type: TAKE_MARKER_TYPE }
}

/** Same delay as injectClap: server triggerAtMs corrected by clock offset. */
export function localTriggerDelayMs(triggerAtMs, offset, now = Date.now()) {
  if (!Number.isFinite(triggerAtMs)) return 0
  return Math.max(0, triggerAtMs - (now + offset))
}

/**
 * Schedule a tone and a boundary callback for the same physical instant.
 * When the audio engine is not ready, returns `{ pending: true }` and does
 * not fire either — same shape as `pendingClaps`.
 */
export function scheduleTakeMarker({
  triggerAtMs,
  offset,
  now = Date.now(),
  engineReady = true,
  scheduleTone,
  onBoundary,
  setTimeoutFn = setTimeout
}) {
  const delayMs = localTriggerDelayMs(triggerAtMs, offset, now)
  if (!engineReady) return { delayMs, pending: true }
  if (typeof scheduleTone === 'function') scheduleTone(delayMs)
  if (typeof onBoundary === 'function') setTimeoutFn(onBoundary, delayMs)
  return { delayMs, pending: false }
}

/** How much of a confirmed-written file is "the take" after a start marker. */
export function presentTake({ samplesWritten, dataByteCount, startSample }) {
  const start = Math.max(0, startSample || 0)
  const startByte = start * 2
  return {
    startSample: start,
    startByte,
    takeSamples: Math.max(0, samplesWritten - start),
    takeBytes: Math.max(0, dataByteCount - startByte)
  }
}

export function countdownSeconds(triggerAtMs, offset, now = Date.now()) {
  const delayMs = localTriggerDelayMs(triggerAtMs, offset, now)
  if (delayMs <= 0) return 0
  return Math.ceil(delayMs / 1000)
}

export function createTakeMarker({
  send,
  isHost,
  getWsStatus,
  getEngineReady,
  scheduleTone,
  getSamplesWritten,
  now = () => Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  onTakeReady,
  onTail
}) {
  let requested = false
  let received = false
  let pendingEvent = null
  let takeReady = false
  let startSample = 0
  let scheduledTriggerAtMs = null
  let scheduledOffset = 0
  let timeoutId = null
  let tailRequested = false
  let tailReceived = false
  let tailDone = false
  let tailFallbackId = null
  let scheduledTailTriggerAtMs = null
  let scheduledTailOffset = 0

  function applyBoundary() {
    if (takeReady) return
    takeReady = true
    startSample = getSamplesWritten()
    onTakeReady?.({ startSample })
  }

  function applyTail({ uncertain = false } = {}) {
    if (tailDone) return
    tailDone = true
    clearTailFallback()
    onTail?.({ uncertain })
  }

  function clearTailFallback() {
    if (tailFallbackId != null) clearTimeoutFn(tailFallbackId)
    tailFallbackId = null
  }

  function receiveTail({ triggerAtMs, offset }) {
    if (tailReceived || tailDone) return { ignored: true }
    tailReceived = true
    scheduledTailTriggerAtMs = triggerAtMs
    scheduledTailOffset = offset
    const result = scheduleTakeMarker({
      triggerAtMs,
      offset,
      now: now(),
      engineReady: getEngineReady(),
      scheduleTone,
      onBoundary: () => applyTail(),
      setTimeoutFn
    })
    // A pending (engine-not-ready) tail never fires its boundary; the
    // fallback stays armed so the host's file still closes.
    if (!result.pending) clearTailFallback()
    return result
  }

  function receive({ triggerAtMs, offset, edge }) {
    if (edge === TAKE_MARKER_EDGE_END) return receiveTail({ triggerAtMs, offset })
    if (received) return { ignored: true }
    received = true
    requested = true
    scheduledTriggerAtMs = triggerAtMs
    scheduledOffset = offset
    const result = scheduleTakeMarker({
      triggerAtMs,
      offset,
      now: now(),
      engineReady: getEngineReady(),
      scheduleTone,
      onBoundary: applyBoundary,
      setTimeoutFn: (fn, ms) => {
        timeoutId = setTimeoutFn(fn, ms)
        return timeoutId
      }
    })
    if (result.pending) pendingEvent = { triggerAtMs, offset }
    return result
  }

  function requestStart({ synced = false } = {}) {
    if (requested) return
    requested = true
    if (synced && getWsStatus() === 'connected') {
      if (isHost()) send(takeMarkerMessage())
      return
    }
    receive({ triggerAtMs: now() + TAKE_MARKER_LEAD_MS, offset: 0 })
  }

  function requestTail({ synced = false } = {}) {
    if (tailRequested) return
    tailRequested = true
    if (synced && getWsStatus() === 'connected') {
      if (!isHost()) return
      send(takeMarkerMessage({ edge: TAKE_MARKER_EDGE_END }))
      tailFallbackId = setTimeoutFn(
        () => applyTail({ uncertain: true }),
        TAKE_MARKER_TAIL_FALLBACK_MS
      )
      return
    }
    receiveTail({ triggerAtMs: now() + TAKE_MARKER_TAIL_LEAD_MS, offset: 0 })
  }

  function onEngineReady() {
    if (!pendingEvent) return
    const ev = pendingEvent
    pendingEvent = null
    received = false
    receive(ev)
  }

  function reset() {
    if (timeoutId != null) clearTimeoutFn(timeoutId)
    timeoutId = null
    clearTailFallback()
    tailRequested = false
    tailReceived = false
    tailDone = false
    scheduledTailTriggerAtMs = null
    scheduledTailOffset = 0
    requested = false
    received = false
    pendingEvent = null
    takeReady = false
    startSample = 0
    scheduledTriggerAtMs = null
    scheduledOffset = 0
  }

  return {
    requestStart,
    requestTail,
    receive,
    onEngineReady,
    reset,
    get takeReady() { return takeReady },
    get startSample() { return startSample },
    get pending() { return pendingEvent != null },
    get scheduledTriggerAtMs() { return scheduledTriggerAtMs },
    get scheduledOffset() { return scheduledOffset },
    get scheduledTailTriggerAtMs() { return scheduledTailTriggerAtMs },
    get scheduledTailOffset() { return scheduledTailOffset }
  }
}
