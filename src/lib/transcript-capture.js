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
// How long after the last interim (non-final) result we keep announcing
// "something's coming" before giving up and going quiet again — covers the
// gap between one interim result and the next during a normal, continuous
// utterance without leaving the room-shared indicator stuck on if the
// browser just stops sending results (e.g. mid-retry).
const ACTIVITY_DECAY_MS = 2000

export function createTranscriptCapture({
  send,
  getSpeakerName,
  onStatusChange,
  createRecognition = createSpeechRecognition,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
} = {}) {
  // Room-shared "a transcript_line is probably about to land" signal (see
  // ws-rooms.js's transcript_activity protocol doc) — deliberately just a
  // boolean, never the interim text itself. Tracked here, not in
  // speech-recognition.js, because it's a decision about what this specific
  // wiring does with an interim result, same reasoning as the isFinal check
  // below.
  let activityActive = false
  let decayTimer = null

  function clearDecayTimer() {
    if (decayTimer == null) return
    clearTimeoutFn(decayTimer)
    decayTimer = null
  }

  function setActivity(next) {
    if (activityActive === next) return
    activityActive = next
    try {
      send({ type: 'transcript_activity', active: next })
    } catch {
      // Same reasoning as the transcript_line send below: a closed/
      // reconnecting room socket must never surface here.
    }
  }

  function noteInterimActivity() {
    setActivity(true)
    clearDecayTimer()
    decayTimer = setTimeoutFn(() => {
      decayTimer = null
      setActivity(false)
    }, ACTIVITY_DECAY_MS)
  }

  const recognition = createRecognition({
    onResult(text, isFinal) {
      if (!isFinal) {
        if (String(text ?? '').trim()) noteInterimActivity()
        return
      }
      // The line this activity was announcing has now actually arrived —
      // go quiet immediately rather than waiting out the decay.
      clearDecayTimer()
      setActivity(false)
      const trimmed = String(text ?? '').trim()
      if (!trimmed) return
      try {
        send({ type: 'transcript_line', speaker: getSpeakerName?.() ?? '', text: trimmed })
      } catch {
        // A closed/reconnecting room socket must never surface here — the
        // transcript line is simply lost, same as any other room message
        // sent while disconnected.
      }
    },
    // Forwarded straight through — see speech-recognition.js's own doc
    // comment for the status values ('unsupported' | 'starting' | 'running'
    // | 'retrying' | 'stopped'). This is what lets the UI show something
    // real about whether this participant is actually being transcribed,
    // instead of silence standing in for "everything's fine" (AGENTS.md's
    // recording-health lesson, applied here too).
    onStatusChange(status) {
      // A dead or retrying recognizer isn't about to produce anything —
      // don't leave the room-shared indicator claiming otherwise.
      if (status === 'stopped' || status === 'retrying') {
        clearDecayTimer()
        setActivity(false)
      }
      onStatusChange?.(status)
    }
  })

  function start() {
    try { recognition.start() } catch { /* never throw into startRecording() */ }
  }

  function stop() {
    try { recognition.stop() } catch { /* never throw into stopRecording() */ }
  }

  return { start, stop, get supported() { return recognition.supported }, get status() { return recognition.status } }
}
