/**
 * AudioWorklet processor — runs in the audio rendering thread.
 *
 * Collects raw PCM Float32 samples from the microphone, buffers them,
 * and posts chunks to the main thread for writing to disk.
 *
 * Also handles clap injection: when told to clap, mixes a 1kHz sine
 * burst (150ms) into the stream so both hosts & guests get an audible,
 * visually distinctive sync marker in their waveforms.
 *
 * Messages IN  (from main thread):
 *   { type: 'clap' }    — inject sync tone now
 *
 * Messages OUT (to main thread):
 *   { type: 'data',   buffer: Float32Array }  — audio chunk ready to write
 *   { type: 'level',  rms: number }           — current RMS level (0-1) for waveform
 */

const BUFFER_SIZE = 8192       // samples per chunk posted to main thread
const CLAP_FREQ   = 1000       // Hz — 1kHz tone for sync marker
const CLAP_AMP    = 0.6        // amplitude of injected tone (loud but not clipping)

class RecorderProcessor extends AudioWorkletProcessor {
  constructor () {
    super()
    this._buffer       = []
    this._clapRemaining = 0  // samples left to inject
    this._clapPhase    = 0   // phase accumulator for sine

    this.port.onmessage = (e) => {
      if (e.data.type === 'clap') {
        // 150ms at whatever sampleRate is (global in worklet scope)
        this._clapRemaining = Math.round(sampleRate * 0.15)
        this._clapPhase = 0
      }
    }
  }

  process (inputs) {
    const channelData = inputs?.[0]?.[0]
    if (!channelData) return true

    const len = channelData.length
    let sumSq = 0
    let peak  = 0

    for (let i = 0; i < len; i++) {
      let s = channelData[i]

      // Inject sync tone if clap is active
      if (this._clapRemaining > 0) {
        const tone = CLAP_AMP * Math.sin(this._clapPhase)
        this._clapPhase += (2 * Math.PI * CLAP_FREQ) / sampleRate
        // Keep phase from growing forever
        if (this._clapPhase > 2 * Math.PI) this._clapPhase -= 2 * Math.PI
        // Mix and hard-clamp so we never clip
        s = Math.max(-1, Math.min(1, s + tone))
        this._clapRemaining--
      }

      this._buffer.push(s)
      sumSq += s * s
      const abs = s < 0 ? -s : s
      if (abs > peak) peak = abs
    }

    // Post RMS + peak for the dBFS meter
    this.port.postMessage({ type: 'level', rms: Math.sqrt(sumSq / len), peak })

    // When buffer is full, post to main thread for writing
    if (this._buffer.length >= BUFFER_SIZE) {
      const chunk = new Float32Array(this._buffer.splice(0, BUFFER_SIZE))
      this.port.postMessage({ type: 'data', buffer: chunk }, [chunk.buffer])
    }

    return true  // keep processor alive
  }
}

registerProcessor('recorder-processor', RecorderProcessor)
