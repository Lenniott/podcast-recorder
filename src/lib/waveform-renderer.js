/**
 * Canvas waveform draw loop + canvas backing-resolution reset.
 *
 * Canvas, analyser node, written-audio ring, recording state, and theme
 * colors all change over the page's lifetime, so they are read live through
 * accessors instead of captured once at construction. The canvas *element*
 * can also be replaced (sidebar remount). The 2d context is rebound whenever
 * getCanvas() returns a different node — keeping the old context is how the
 * waveform goes blank while the level meter (not canvas-backed) still moves.
 */
export function createWaveformRenderer({
  getCanvas,
  getAnalyserNode,
  getWrittenRing,
  isRecording,
  getColors
}) {
  let canvasCtx = null
  let boundCanvas = null
  let animFrame = null
  let analyserData = null

  function bindCanvas(canvas) {
    if (!canvas) {
      boundCanvas = null
      canvasCtx = null
      return null
    }
    if (boundCanvas !== canvas) {
      boundCanvas = canvas
      canvasCtx = canvas.getContext('2d')
    }
    return canvasCtx
  }

  function draw() {
    animFrame = requestAnimationFrame(draw)
    const canvas = getCanvas()
    const analyserNode = getAnalyserNode()
    if (!canvas || !analyserNode) return

    canvasCtx = bindCanvas(canvas)
    if (!analyserData || analyserData.length !== analyserNode.fftSize) {
      analyserData = new Float32Array(analyserNode.fftSize)
    }

    const W = canvas.width
    const H = canvas.height
    canvasCtx.clearRect(0, 0, W, H)

    const writtenRing = getWrittenRing()
    if (isRecording() && writtenRing) {
      writtenRing.read(analyserData)
    } else {
      analyserNode.getFloatTimeDomainData(analyserData)
    }

    const { bg, centerLine, stroke, strokeRec } = getColors()

    canvasCtx.fillStyle = bg
    canvasCtx.fillRect(0, 0, W, H)

    canvasCtx.strokeStyle = centerLine
    canvasCtx.lineWidth = 1
    canvasCtx.beginPath()
    canvasCtx.moveTo(0, H / 2)
    canvasCtx.lineTo(W, H / 2)
    canvasCtx.stroke()

    let peak = 0
    for (let i = 0; i < analyserData.length; i++) {
      const a = Math.abs(analyserData[i])
      if (a > peak) peak = a
    }
    const noiseFloor = 0.015
    const scale = peak < noiseFloor ? 1 : Math.min(24, 0.9 / peak)

    canvasCtx.strokeStyle = isRecording() ? strokeRec : stroke
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

  function resizeCanvas() {
    const canvas = getCanvas()
    if (!canvas) return
    canvasCtx = bindCanvas(canvas)
    canvas.width = canvas.offsetWidth
    canvas.height = canvas.offsetHeight
  }

  return { start, stop, resizeCanvas }
}
