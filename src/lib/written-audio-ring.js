/**
 * A fixed-size ring buffer of the most recently WRITTEN (not captured, not
 * merely queued) audio samples, in chronological order — the same shape
 * `AnalyserNode.getFloatTimeDomainData()` gives you, so it's a drop-in
 * replacement for whatever draws the live waveform.
 *
 * The point: feed the live waveform from this instead of the mic's
 * AnalyserNode while recording. The mic signal can look perfectly normal
 * while the file being written silently diverges from it (this app's own
 * production bug did exactly that) — a display fed from confirmed-written
 * audio can't lie that way. If the disk falls behind, this display falls
 * behind with it, visibly, instead of drawing a healthy-looking scope over
 * a broken recording.
 */
export function createWrittenAudioRing(size) {
  if (!(size > 0)) throw new Error('createWrittenAudioRing: size must be > 0')

  const buf = new Float32Array(size)
  let writeIdx = 0
  let filled = 0

  /** Push one confirmed-written chunk (Int16Array) into the ring. */
  function push(i16) {
    for (let i = 0; i < i16.length; i++) {
      buf[writeIdx] = i16[i] / 32768
      writeIdx = (writeIdx + 1) % size
      if (filled < size) filled++
    }
  }

  /**
   * Fill `out` (a Float32Array, any length) with the most recent samples in
   * chronological order (oldest → newest), matching getFloatTimeDomainData.
   * Unfilled ring positions (before enough audio has ever been written)
   * read back as 0 — silence, not garbage.
   */
  function read(out) {
    const n = out.length
    const avail = Math.min(n, filled)
    const leadingZeros = n - avail
    const start = (writeIdx - avail + size) % size
    for (let i = 0; i < leadingZeros; i++) out[i] = 0
    for (let i = 0; i < avail; i++) out[leadingZeros + i] = buf[(start + i) % size]
  }

  return { push, read, size }
}
