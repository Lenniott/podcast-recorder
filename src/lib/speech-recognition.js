/**
 * Thin wrapper around the browser's SpeechRecognition /
 * webkitSpeechRecognition API, mirroring $lib/audio-engine.js's convention
 * of wrapping a browser media API behind injectable dependencies so it's
 * unit-testable without a real browser API (see
 * tests/unit/audio-engine.test.js).
 */
export function createSpeechRecognition({
  getRecognizerCtor = () =>
    typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : undefined,
  onResult,
  onError
} = {}) {
  const RecognizerCtor = getRecognizerCtor()
  const supported = typeof RecognizerCtor === 'function'

  let recognizer = null
  // True from start() to stop() (inclusive of any auto-restarts in
  // between) — the single source of truth for "should recognition be
  // running right now", independent of whatever the underlying API is
  // actually doing at this instant.
  let wantsRunning = false

  function startInstance() {
    recognizer = new RecognizerCtor()
    recognizer.continuous = true
    recognizer.interimResults = true
    recognizer.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        onResult?.(result[0]?.transcript ?? '', result.isFinal === true)
      }
    }
    recognizer.onerror = (event) => {
      // A network hiccup, permission denial, or any other recognition-path
      // failure must never throw into a caller mid-recording (AGENTS.md's
      // one hard rule) — at most report it, never propagate.
      try { onError?.(event) } catch { /* never rethrow into the caller */ }
    }
    recognizer.onend = () => {
      // Real Chrome quirk: the underlying API can stop itself mid-session
      // (e.g. after a stretch of silence) with no explicit stop() call.
      // Restart iff we still want it running — never once told to stop.
      if (wantsRunning) {
        try { startInstance() } catch { /* swallow — see doc comment above */ }
      }
    }
    try {
      recognizer.start()
    } catch {
      // Some browsers throw if start() races an already-starting instance,
      // or if the mic is unavailable — never let that surface to the caller.
    }
  }

  function start() {
    if (!supported) return
    wantsRunning = true
    try { startInstance() } catch { /* never throw into the caller — see startInstance's onerror doc comment */ }
  }

  function stop() {
    wantsRunning = false
    try { recognizer?.stop() } catch { /* never throw into the caller */ }
  }

  return { start, stop, get supported() { return supported } }
}
