/**
 * Thin wrapper around the browser's SpeechRecognition /
 * webkitSpeechRecognition API, mirroring $lib/audio-engine.js's convention
 * of wrapping a browser media API behind injectable dependencies so it's
 * unit-testable without a real browser API (see
 * tests/unit/audio-engine.test.js).
 *
 * Two very different "it stopped" cases have to be told apart, or this
 * either goes silent forever or hammers the browser:
 *
 *   - A session that actually got going (the browser fired `onstart`) and
 *     then ended itself — the routine Chrome quirk of ending a
 *     `continuous` session after a stretch of silence. Restart
 *     IMMEDIATELY, no backoff: this happens constantly during any real
 *     conversation with pauses, and a multi-second gap here would be a
 *     real, noticeable regression in how live the transcript feels.
 *   - A session that never got going at all — `recognizer.start()` threw
 *     synchronously, or it ended without ever firing `onstart` (mic
 *     unavailable, browser refusing, etc.). This used to be swallowed and
 *     left dead: `wantsRunning` stayed true forever with nothing left to
 *     ever retry it, since the only retry hook was `onend`, and a
 *     synchronous throw from `start()` never gets a session to end.
 *     Retried now too, but with capped exponential backoff (same shape as
 *     room-connection.js's reconnect backoff, reimplemented locally rather
 *     than imported — same reasoning server-copy-upload.js gives for doing
 *     the same: this module is deliberately independent of the room
 *     socket) — so a genuinely broken mic doesn't spin the browser in a
 *     tight loop, but a permission re-grant or a replugged mic still gets
 *     picked back up on its own.
 *
 * `onStatusChange` reports which of these is happening
 * ('unsupported' | 'starting' | 'running' | 'retrying' | 'stopped') so a
 * caller can show something real instead of the UI going quiet — the same
 * lesson AGENTS.md already states for recording health applies here:
 * never let silence stand in for "everything's fine."
 */

const RETRY_BASE_MS = 1000
const RETRY_CAP_MS = 15000

function nextRetryDelay(attempt) {
  const exp = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** attempt)
  return exp * (0.5 + Math.random() * 0.5)
}

export function createSpeechRecognition({
  getRecognizerCtor = () =>
    typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : undefined,
  onResult,
  onError,
  onStatusChange,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
} = {}) {
  const RecognizerCtor = getRecognizerCtor()
  const supported = typeof RecognizerCtor === 'function'

  let recognizer = null
  // True from start() to stop() (inclusive of any auto-restarts or
  // backoff-retries in between) — the single source of truth for "should
  // recognition be running right now", independent of whatever the
  // underlying API is actually doing at this instant.
  let wantsRunning = false
  let confirmedRunning = false // did the CURRENT attempt's onstart fire yet
  let retryAttempt = 0
  let retryTimer = null
  let status = supported ? 'stopped' : 'unsupported'

  function setStatus(next) {
    if (status === next) return
    status = next
    onStatusChange?.(next)
  }

  function clearRetryTimer() {
    if (retryTimer == null) return
    clearTimeoutFn(retryTimer)
    retryTimer = null
  }

  /** The session never got going (a synchronous start() throw, or an end
   *  with no preceding onstart) — schedule a backed-off retry rather than
   *  dying silently. A no-op once told to stop. */
  function scheduleRetry() {
    if (!wantsRunning) return
    setStatus('retrying')
    const delay = nextRetryDelay(retryAttempt)
    retryAttempt += 1
    retryTimer = setTimeoutFn(() => {
      retryTimer = null
      if (wantsRunning) startInstance()
    }, delay)
    retryTimer?.unref?.()
  }

  function startInstance() {
    confirmedRunning = false
    recognizer = new RecognizerCtor()
    recognizer.continuous = true
    recognizer.interimResults = true
    recognizer.onstart = () => {
      confirmedRunning = true
      retryAttempt = 0 // a real, confirmed start earns back a clean slate
      setStatus('running')
    }
    recognizer.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        onResult?.(result[0]?.transcript ?? '', result.isFinal === true)
      }
    }
    recognizer.onerror = (event) => {
      // A network hiccup, permission denial, or any other recognition-path
      // failure must never throw into a caller mid-recording (AGENTS.md's
      // one hard rule) — at most report it, never propagate. The retry
      // decision itself is onend's job (browsers fire onerror then onend
      // for the same failure), not this handler's, so a failure is never
      // decided on twice.
      try { onError?.(event) } catch { /* never rethrow into the caller */ }
    }
    recognizer.onend = () => {
      if (!wantsRunning) {
        setStatus('stopped')
        return
      }
      if (confirmedRunning) {
        // The routine case — restart immediately, no backoff (see module
        // doc comment).
        startInstance()
      } else {
        scheduleRetry()
      }
    }
    try {
      recognizer.start()
    } catch {
      // Synchronous throw — no onstart, no onend will ever fire for this
      // attempt, so this is the one place that must schedule its own
      // retry rather than relying on onend to notice.
      scheduleRetry()
    }
  }

  function start() {
    if (!supported) return
    clearRetryTimer()
    wantsRunning = true
    retryAttempt = 0
    setStatus('starting')
    startInstance()
  }

  function stop() {
    wantsRunning = false
    clearRetryTimer()
    setStatus('stopped')
    try { recognizer?.stop() } catch { /* never throw into the caller */ }
  }

  return {
    start,
    stop,
    get supported() { return supported },
    get status() { return status }
  }
}
