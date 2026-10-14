import { buildWavBlob } from './audio-utils.js'
import {
  CHECK_TURN,
  SHARE_AFTER_SAMPLES,
  MAX_SHARE_SAMPLES,
  isCheckTurn
} from './recording-check-share.js'

export { CHECK_TURN }

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

/**
 * Host-then-guest Check Turn sequence for a Synced Recording Session.
 * Solo start skips this pairing: this peer's existing single-person check
 * still opens, and confirm() is the both-turns-passed signal (there is no
 * guest turn to wait on). Stay-quiet is derived only from `turn`.
 */
export function createCheckTurnSequence() {
  let turn = CHECK_TURN.idle
  let synced = false
  let emittedPassed = false
  const passedListeners = new Set()

  function emitPassed() {
    if (emittedPassed) return
    emittedPassed = true
    turn = CHECK_TURN.passed
    for (const fn of passedListeners) fn()
  }

  function start({ synced: nextSynced = false } = {}) {
    synced = !!nextSynced
    emittedPassed = false
    turn = synced ? CHECK_TURN.host : CHECK_TURN.idle
  }

  function shouldOpenOwnCheck({ isHost } = {}) {
    if (!synced) return turn !== CHECK_TURN.passed
    if (turn === CHECK_TURN.host) return !!isHost
    if (turn === CHECK_TURN.guest) return !isHost
    return false
  }

  function stayQuietRole({ isHost } = {}) {
    if (!synced) return null
    if (turn === CHECK_TURN.host && !isHost) return CHECK_TURN.host
    if (turn === CHECK_TURN.guest && isHost) return CHECK_TURN.guest
    return null
  }

  function confirm({ isHost } = {}) {
    if (!synced) {
      emitPassed()
      return
    }
    if (isHost && turn === CHECK_TURN.host) {
      turn = CHECK_TURN.guest
      return
    }
    if (!isHost && turn === CHECK_TURN.guest) emitPassed()
  }

  function reject({ isHost } = {}) {
    if (!synced) {
      turn = CHECK_TURN.idle
      emittedPassed = false
      return
    }
    if (isHost && turn === CHECK_TURN.host) {
      turn = CHECK_TURN.host
      return
    }
    if (!isHost && turn === CHECK_TURN.guest) {
      turn = CHECK_TURN.host
    }
  }

  function applyRemote(nextTurn) {
    if (!isCheckTurn(nextTurn)) return
    if (nextTurn === CHECK_TURN.idle) {
      synced = false
      emittedPassed = false
      turn = CHECK_TURN.idle
      return
    }
    synced = true
    if (nextTurn === CHECK_TURN.passed) {
      emitPassed()
      return
    }
    turn = nextTurn
  }

  function close() {
    turn = CHECK_TURN.idle
    synced = false
    emittedPassed = false
  }

  function onBothTurnsPassed(fn) {
    passedListeners.add(fn)
    return () => passedListeners.delete(fn)
  }

  return {
    start,
    confirm,
    reject,
    applyRemote,
    close,
    shouldOpenOwnCheck,
    stayQuietRole,
    onBothTurnsPassed,
    get turn() { return turn },
    get bothTurnsPassed() { return turn === CHECK_TURN.passed },
    get synced() { return synced }
  }
}
