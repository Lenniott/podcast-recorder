import { buildWavBlob } from './audio-utils.js'

/**
 * Record-start listen-back check. Callers must feed confirmed-written chunks,
 * not raw mic input, so the preview reflects what actually reached disk.
 */
export const CHECK_SENTENCES = [
  'The quick brown fox jumps over the lazy dog.',
  'Pack my box with five dozen liquor jugs.',
  'Sphinx of black quartz, judge my vow.',
  'How vexingly quick daft zebras jump.',
  'Bright vixens jump; dozy fowl quack.'
]

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
    close: closeAndClear,
    get open() { return open },
    get sentence() { return sentence }
  }
}
