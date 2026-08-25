import { buildWavBlob } from './audio-utils.js'

/**
 * Record-start listen-back check: after Start, the host/guest is asked to
 * read a random sentence back, so they catch a bad mic or wrong device
 * before committing minutes of a real take to it.
 *
 * Buffers only chunks the caller feeds via handleWritten() — the page must
 * only feed this confirmed-WRITTEN audio (Capture Writer's onWritten), never
 * raw mic input, the same requirement buildWavBlob's own doc comment
 * describes: it's the only way this check could have caught this app's
 * actual production bug (the file silently diverging from a healthy-looking
 * mic signal).
 */

export const CHECK_SENTENCES = [
  'The quick brown fox jumps over the lazy dog.',
  'Pack my box with five dozen liquor jugs.',
  'Sphinx of black quartz, judge my vow.',
  'How vexingly quick daft zebras jump.',
  'Bright vixens jump; dozy fowl quack.'
]

// Cap buffering at 30s regardless of sample rate specifics, so a host who
// leaves the check open doesn't grow the buffer unbounded.
const DEFAULT_MAX_PREVIEW_SAMPLES = 30 * 48000

export function createRecordingCheck({ maxPreviewSamples = DEFAULT_MAX_PREVIEW_SAMPLES } = {}) {
  let open = false
  let sentence = ''
  let collecting = false
  let chunks = []
  let sampleCount = 0

  function start() {
    sentence = CHECK_SENTENCES[Math.floor(Math.random() * CHECK_SENTENCES.length)]
    chunks = []
    sampleCount = 0
    collecting = true
    open = true
  }

  /** Feed one confirmed-written chunk (Int16Array). No-op unless collecting. */
  function handleWritten(i16) {
    if (!collecting || sampleCount >= maxPreviewSamples) return
    chunks.push(i16)
    sampleCount += i16.length
  }

  function buildPreview(sampleRate) {
    return buildWavBlob(chunks, sampleRate)
  }

  function closeAndClear() {
    open = false
    collecting = false
    chunks = []
    sampleCount = 0
  }

  return {
    start,
    handleWritten,
    buildPreview,
    confirm: closeAndClear,
    reject: closeAndClear,
    // Alias for callers closing the check for a reason that's neither a
    // confirm nor a reject (e.g. Stop was pressed while the check was still
    // open) — same effect, named for that call site's own intent.
    close: closeAndClear,
    get open() { return open },
    get sentence() { return sentence }
  }
}
