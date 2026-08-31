import { createSpeechRecognition } from './speech-recognition.js'

/**
 * Wires the Record button's lifecycle to speech recognition and the
 * Transcript Tab wire protocol (ticket 01's `{ type: 'transcript_line',
 * speaker, text }` message — see src/lib/server/ws-rooms.js's protocol doc
 * comment).
 *
 * This is the small, testable module the "no monolithic files" design
 * requirement calls for: it owns the one decision +page.svelte would
 * otherwise have to inline — "only a FINALIZED result becomes a
 * transcript_line, labeled with the current speaker name" — so that
 * decision has its own unit tests (mirroring how $lib/exit-guard.js and
 * $lib/server-copy-status.js keep decision logic out of the page
 * component) independent of Svelte and the room WebSocket.
 *
 * start()/stop() are meant to be called 1:1 with the page's own
 * startRecording()/stopRecording() (ADR-0003: no separate consent step).
 * Every path here is wrapped so a failure — an unsupported browser, a
 * permission denial, a mid-session network hiccup, or a `send` that throws
 * because the room socket is down — can never propagate into the caller.
 * That is deliberate: AGENTS.md's one hard rule means this module must
 * never be capable of delaying or interrupting capture-writer.js's local
 * WAV write path, which lives entirely outside this module and is never
 * awaited or blocked on by anything here.
 */
export function createTranscriptCapture({ send, getSpeakerName, createRecognition = createSpeechRecognition } = {}) {
  const recognition = createRecognition({
    onResult(text, isFinal) {
      if (!isFinal) return
      const trimmed = String(text ?? '').trim()
      if (!trimmed) return
      try {
        send({ type: 'transcript_line', speaker: getSpeakerName?.() ?? '', text: trimmed })
      } catch {
        // A closed/reconnecting room socket must never surface here — the
        // transcript line is simply lost, same as any other room message
        // sent while disconnected.
      }
    }
  })

  function start() {
    try { recognition.start() } catch { /* never throw into startRecording() */ }
  }

  function stop() {
    try { recognition.stop() } catch { /* never throw into stopRecording() */ }
  }

  return { start, stop, get supported() { return recognition.supported } }
}
