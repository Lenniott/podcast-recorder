import { buildWavBlob } from './audio-utils.js'
import { SHARE_AFTER_SAMPLES, MAX_SHARE_SAMPLES } from './recording-check-share.js'

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

export function createRecordingCheck({
  maxPreviewSamples = DEFAULT_MAX_PREVIEW_SAMPLES,
  shareAfterSamples = SHARE_AFTER_SAMPLES,
  maxShareSamples = MAX_SHARE_SAMPLES
} = {}) {
  let open = false
  let sentence = ''
  let collecting = false
  let chunks = []
  let sampleCount = 0
  let autoShareReady = false
  let autoShareConsumed = false

  function start() {
    sentence = CHECK_SENTENCES[Math.floor(Math.random() * CHECK_SENTENCES.length)]
    chunks = []
    sampleCount = 0
    autoShareReady = false
    autoShareConsumed = false
    collecting = true
    open = true
  }

  function handleWritten(i16) {
    if (!collecting || sampleCount >= maxPreviewSamples) return
    chunks.push(i16)
    sampleCount += i16.length
    if (!autoShareReady && sampleCount >= shareAfterSamples) autoShareReady = true
  }

  function buildPreview(sampleRate) {
    return buildWavBlob(chunks, sampleRate)
  }

  function sharePcm() {
    const n = Math.min(sampleCount, maxShareSamples)
    const out = new Int16Array(n)
    let offset = 0
    for (const c of chunks) {
      if (offset >= n) break
      const take = Math.min(c.length, n - offset)
      out.set(c.subarray(0, take), offset)
      offset += take
    }
    return out
  }

  function consumeAutoShare() {
    if (!autoShareReady || autoShareConsumed) return false
    autoShareConsumed = true
    return true
  }

  function closeAndClear() {
    open = false
    collecting = false
    chunks = []
    sampleCount = 0
    autoShareReady = false
    autoShareConsumed = false
  }

  return {
    start,
    handleWritten,
    buildPreview,
    sharePcm,
    consumeAutoShare,
    confirm: closeAndClear,
    reject: closeAndClear,
    close: closeAndClear,
    get open() { return open },
    get sentence() { return sentence }
  }
}
