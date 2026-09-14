import { describe, it, expect, afterEach, vi } from 'vitest'
import { createWaveformRenderer } from '../../src/lib/recording/waveform-renderer.js'

function createContext() {
  return {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0
  }
}

function createCanvas(ctx = createContext()) {
  return {
    width: 100,
    height: 40,
    offsetWidth: 120,
    offsetHeight: 50,
    getContext: vi.fn(() => ctx)
  }
}

describe('createWaveformRenderer', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('resizeCanvas updates the drawing buffer from on-screen size', () => {
    const canvas = createCanvas()
    const renderer = createWaveformRenderer({
      getCanvas: () => canvas,
      getAnalyserNode: () => null,
      getWrittenRing: () => null,
      isRecording: () => false,
      getColors: () => ({ bg: 'white', centerLine: 'gray', stroke: 'black', strokeRec: 'green' })
    })

    renderer.resizeCanvas()

    expect(canvas.width).toBe(120)
    expect(canvas.height).toBe(50)
  })

  it('draws live analyser audio with page-provided idle colors', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const ctx = createContext()
    const canvas = createCanvas(ctx)
    const analyser = {
      fftSize: 4,
      getFloatTimeDomainData: vi.fn((data) => data.set([0, 0.1, -0.1, 0]))
    }
    const renderer = createWaveformRenderer({
      getCanvas: () => canvas,
      getAnalyserNode: () => analyser,
      getWrittenRing: () => null,
      isRecording: () => false,
      getColors: () => ({ bg: 'white', centerLine: 'gray', stroke: 'black', strokeRec: 'green' })
    })

    renderer.start()

    expect(analyser.getFloatTimeDomainData).toHaveBeenCalledOnce()
    expect(ctx.fillStyle).toBe('white')
    expect(ctx.strokeStyle).toBe('black')
    expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, 100, 40)
    renderer.stop()
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1)
  })

  it('draws confirmed-written audio while recording', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    const ctx = createContext()
    const canvas = createCanvas(ctx)
    const analyser = { fftSize: 4, getFloatTimeDomainData: vi.fn() }
    const writtenRing = { read: vi.fn((data) => data.set([0.2, 0, -0.2, 0])) }
    const renderer = createWaveformRenderer({
      getCanvas: () => canvas,
      getAnalyserNode: () => analyser,
      getWrittenRing: () => writtenRing,
      isRecording: () => true,
      getColors: () => ({ bg: 'white', centerLine: 'gray', stroke: 'black', strokeRec: 'green' })
    })

    renderer.start()

    expect(writtenRing.read).toHaveBeenCalledOnce()
    expect(analyser.getFloatTimeDomainData).not.toHaveBeenCalled()
    expect(ctx.strokeStyle).toBe('green')
  })

  it('does nothing when canvas or analyser is unavailable', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    const renderer = createWaveformRenderer({
      getCanvas: () => null,
      getAnalyserNode: () => null,
      getWrittenRing: () => null,
      isRecording: () => false,
      getColors: () => ({ bg: 'white', centerLine: 'gray', stroke: 'black', strokeRec: 'green' })
    })

    expect(() => renderer.start()).not.toThrow()
    expect(requestAnimationFrame).toHaveBeenCalled()
  })

  it('draws onto a replacement canvas after the live node is remounted', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    const firstCtx = createContext()
    const secondCtx = createContext()
    const first = createCanvas(firstCtx)
    const second = createCanvas(secondCtx)
    let live = first
    const analyser = {
      fftSize: 4,
      getFloatTimeDomainData: vi.fn((data) => data.set([0, 0.1, -0.1, 0]))
    }
    const renderer = createWaveformRenderer({
      getCanvas: () => live,
      getAnalyserNode: () => analyser,
      getWrittenRing: () => null,
      isRecording: () => false,
      getColors: () => ({ bg: 'white', centerLine: 'gray', stroke: 'black', strokeRec: 'green' })
    })

    renderer.start()
    expect(second.getContext).not.toHaveBeenCalled()
    expect(firstCtx.fillRect).toHaveBeenCalled()

    live = second
    renderer.start()

    expect(second.getContext).toHaveBeenCalled()
    expect(secondCtx.fillRect).toHaveBeenCalledWith(0, 0, 100, 40)
  })
})
