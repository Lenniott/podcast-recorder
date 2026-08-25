/**
 * Canvas waveform draw loop + canvas backing-resolution reset.
 *
 * Canvas, analyser node, written-audio ring, and recording state all
 * change over the page's lifetime (mic not yet initialized, sidebar
 * collapse resize, recording start/stop) — so these are all read live via
 * injected accessors rather than captured once at construction.
 *
 * Canvas-bound (requestAnimationFrame + 2D context), same as the inline
 * code this replaces — no unit test, covered by the existing Playwright
 * specs (sidebar_collapse.spec.js exercises the resize path).
 */
export function createWaveformRenderer({ getCanvas, getAnalyserNode, getWrittenRing, isRecording }) {
  let canvasCtx = null
  let animFrame = null
  let analyserData = null

  function draw() {
    animFrame = requestAnimationFrame(draw)
    const canvas = getCanvas()
    const analyserNode = getAnalyserNode()
    if (!canvas || !analyserNode) return

    canvasCtx = canvasCtx || canvas.getContext('2d')
    if (!analyserData || analyserData.length !== analyserNode.fftSize) {
      analyserData = new Float32Array(analyserNode.fftSize)
    }

    const W = canvas.width
    const H = canvas.height
    canvasCtx.clearRect(0, 0, W, H)

    // While recording, draw from confirmed-written audio, not the live
    // mic — see written-audio-ring.js's doc comment for why. Pre-recording
    // (mic check before pressing Start, when nothing has been written yet),
    // the live mic signal is the only thing there is to show.
    const writtenRing = getWrittenRing()
    if (isRecording() && writtenRing) {
      writtenRing.read(analyserData)
    } else {
      analyserNode.getFloatTimeDomainData(analyserData)
    }

    // Background
    canvasCtx.fillStyle = '#0e0e10'
    canvasCtx.fillRect(0, 0, W, H)

    // Centre line
    canvasCtx.strokeStyle = '#2a2a2e'
    canvasCtx.lineWidth = 1
    canvasCtx.beginPath()
    canvasCtx.moveTo(0, H / 2)
    canvasCtx.lineTo(W, H / 2)
    canvasCtx.stroke()

    // Visual-only auto-gain: speech is far below 0 dBFS, so 1:1 mapping
    // is a 2px wiggle on this short canvas. Recording path is unchanged.
    let peak = 0
    for (let i = 0; i < analyserData.length; i++) {
      const a = Math.abs(analyserData[i])
      if (a > peak) peak = a
    }
    const noiseFloor = 0.015 // ≈ -36 dBFS
    const scale = peak < noiseFloor ? 1 : Math.min(24, 0.9 / peak)

    const isRec = isRecording()
    canvasCtx.strokeStyle = isRec ? '#a855f7' : '#52525b'
    canvasCtx.lineWidth = 1.5
    canvasCtx.beginPath()

    const sliceWidth = W / analyserData.length
    let x = 0

    for (let i = 0; i < analyserData.length; i++) {
      const y = Math.max(0, Math.min(H, (analyserData[i] * scale * 0.5 + 0.5) * H))
      if (i === 0) canvasCtx.moveTo(x, y)
      else canvasCtx.lineTo(x, y)
      x += sliceWidth
    }
    canvasCtx.stroke()
  }

  function start() {
    draw()
  }

  function stop() {
    cancelAnimationFrame(animFrame)
  }

  /**
   * `width`/`height` attributes (not CSS size) set the drawing buffer, so
   * this needs re-running whenever the canvas's on-screen size changes —
   * initial mount, and toggling the sidebar collapse.
   */
  function resizeCanvas() {
    const canvas = getCanvas()
    if (!canvas) return
    canvasCtx = canvasCtx || canvas.getContext('2d')
    canvas.width = canvas.offsetWidth
    canvas.height = canvas.offsetHeight
  }

  return { start, stop, resizeCanvas }
}
