import { describe, it, expect, afterEach, vi } from 'vitest'
import { createAudioEngine } from '../../src/lib/recording/audio-engine.js'

function createTrack(label = 'Input') {
  return { label, onended: null, stop: vi.fn() }
}

function createStream(label = 'Input') {
  const track = createTrack(label)
  return {
    track,
    getTracks: () => [track],
    getAudioTracks: () => [track]
  }
}

function createNode(name) {
  return {
    name,
    connect: vi.fn(),
    disconnect: vi.fn(),
    gain: { value: 1 },
    fftSize: 0
  }
}

function installAudioGlobals({ sampleRate = 48000, state = 'running' } = {}) {
  const ctx = {
    sampleRate,
    state,
    currentTime: 10,
    destination: createNode('destination'),
    audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
    resume: vi.fn(async () => { ctx.state = 'running' }),
    close: vi.fn(),
    createAnalyser: vi.fn(() => createNode('analyser')),
    createGain: vi.fn(() => createNode('gain')),
    createMediaStreamSource: vi.fn(() => createNode('micSource'))
  }
  const AudioContext = vi.fn(function AudioContext() {
    return ctx
  })
  const workletNode = {
    connect: vi.fn(),
    port: {
      onmessage: null,
      postMessage: vi.fn()
    }
  }
  const AudioWorkletNode = vi.fn(function AudioWorkletNode() {
    return workletNode
  })

  vi.stubGlobal('AudioContext', AudioContext)
  vi.stubGlobal('AudioWorkletNode', AudioWorkletNode)

  return { ctx, AudioContext, AudioWorkletNode, workletNode }
}

function createEngine(overrides = {}) {
  const devices = overrides.devices ?? [{ deviceId: 'mic-1', label: 'Mic 1' }]
  let selectedDeviceId = overrides.selectedDeviceId ?? 'mic-1'
  const calls = {
    level: [],
    chunks: [],
    gaps: [],
    micConnected: vi.fn(),
    loadDevices: vi.fn(async () => {}),
    setSelectedDeviceId: vi.fn((id) => { selectedDeviceId = id }),
    setMicFallback: vi.fn(),
    setMicFallbackName: vi.fn(),
    setMicPermissionDenied: vi.fn()
  }
  const engine = createAudioEngine({
    onLevel: (rms, peak) => calls.level.push({ rms, peak }),
    onChunk: (buffer) => calls.chunks.push(buffer),
    onDeviceGapResolved: (gapSec) => calls.gaps.push(gapSec),
    onMicConnected: calls.micConnected,
    loadDevices: calls.loadDevices,
    getDevices: () => devices,
    getSelectedDeviceId: () => selectedDeviceId,
    setSelectedDeviceId: calls.setSelectedDeviceId,
    setMicFallback: calls.setMicFallback,
    setMicFallbackName: calls.setMicFallbackName,
    setMicPermissionDenied: calls.setMicPermissionDenied
  })
  return { engine, calls, get selectedDeviceId() { return selectedDeviceId } }
}

describe('createAudioEngine', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('initializes the graph, connects the selected mic, and forwards worklet messages', async () => {
    const { ctx, AudioContext, AudioWorkletNode, workletNode } = installAudioGlobals({ sampleRate: 44100 })
    const stream = createStream('Mic 1')
    const getUserMedia = vi.fn(async () => stream)
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
    const { engine, calls } = createEngine()

    await engine.init()

    expect(AudioContext).toHaveBeenCalledWith({ sampleRate: 48000 })
    expect(ctx.audioWorklet.addModule).toHaveBeenCalledWith('/worklet/recorder-processor.js')
    expect(AudioWorkletNode).toHaveBeenCalledWith(ctx, 'recorder-processor')
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        deviceId: { ideal: 'mic-1' },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1
      }
    })
    expect(calls.micConnected).toHaveBeenCalledOnce()
    expect(calls.gaps).toEqual([0])
    expect(engine.sampleRate).toBe(44100)
    expect(engine.getAnalyserNode().fftSize).toBe(2048)

    const buffer = new Float32Array([0.1, -0.1])
    workletNode.port.onmessage({ data: { type: 'level', rms: 0.2, peak: 0.5 } })
    workletNode.port.onmessage({ data: { type: 'data', buffer } })
    expect(calls.level).toEqual([{ rms: 0.2, peak: 0.5 }])
    expect(calls.chunks).toEqual([buffer])
  })

  it('resumes a suspended context and updates gain/clap/debug messages', async () => {
    vi.useFakeTimers()
    const { ctx, workletNode } = installAudioGlobals({ state: 'suspended' })
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => createStream()) } })
    const { engine } = createEngine()

    await engine.init()
    expect(ctx.resume).toHaveBeenCalledOnce()

    ctx.state = 'suspended'
    await engine.ensureRunning()
    expect(ctx.resume).toHaveBeenCalledTimes(2)

    engine.setGain(2)
    expect(ctx.createGain.mock.results.at(-1).value.gain.value).toBe(2)

    engine.scheduleClapTone(25)
    vi.advanceTimersByTime(25)
    expect(workletNode.port.postMessage).toHaveBeenCalledWith({ type: 'clap' })

    engine.postDebugMarker()
    expect(workletNode.port.postMessage).toHaveBeenCalledWith({ type: 'debug_marker' })
    vi.useRealTimers()
  })

  it('manual mic changes require the exact selected device', async () => {
    installAudioGlobals()
    const getUserMedia = vi.fn(async () => createStream())
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
    const { engine } = createEngine()

    await engine.init()
    await engine.changeMic('mic-2')

    expect(getUserMedia).toHaveBeenLastCalledWith(expect.objectContaining({
      audio: expect.objectContaining({ deviceId: { exact: 'mic-2' } })
    }))
  })

  it('fallback reconnect keeps the selected device when it is still available', async () => {
    installAudioGlobals()
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => createStream()) } })
    const { engine, calls } = createEngine()

    await engine.init()
    calls.setMicFallback.mockClear()
    await engine.connectMicWithFallback()

    expect(calls.loadDevices).toHaveBeenCalledOnce()
    expect(calls.setMicFallback).toHaveBeenCalledWith(false)
    expect(calls.setSelectedDeviceId).not.toHaveBeenCalled()
  })

  it('fallback reconnect switches to another listed microphone when the selected one fails', async () => {
    installAudioGlobals()
    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce(createStream('Mic 1'))
      .mockRejectedValueOnce(new Error('selected gone'))
      .mockResolvedValueOnce(createStream('Backup Mic'))
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
    const { engine, calls } = createEngine({
      devices: [
        { deviceId: 'mic-1', label: 'Mic 1' },
        { deviceId: 'mic-2', label: 'Backup Mic' }
      ]
    })

    await engine.init()
    await engine.connectMicWithFallback()

    expect(calls.setSelectedDeviceId).toHaveBeenCalledWith('mic-2')
    expect(calls.setMicFallback).toHaveBeenCalledWith(true)
    expect(calls.setMicFallbackName).toHaveBeenCalledWith('Backup Mic')
  })

  it('last-resort fallback lets the browser choose and marks permission denied if that fails', async () => {
    installAudioGlobals()
    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce(createStream('Mic 1'))
      .mockRejectedValueOnce(new Error('selected gone'))
      .mockResolvedValueOnce(createStream('Built-in'))
      .mockRejectedValueOnce(new Error('no mic'))
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
    const { engine, calls } = createEngine({ devices: [{ deviceId: 'mic-1', label: 'Mic 1' }] })

    await engine.init()
    await engine.connectMicWithFallback()
    expect(calls.setMicFallbackName).toHaveBeenCalledWith('Built-in')

    await engine.connectMicWithFallback()
    expect(calls.setMicPermissionDenied).toHaveBeenCalledOnce()
  })

  it('clearPendingGap prevents a pre-recording gap from being reported on reconnect', async () => {
    const { ctx } = installAudioGlobals()
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => createStream()) } })
    const { engine, calls } = createEngine()

    await engine.init()
    calls.gaps.length = 0
    ctx.currentTime = 20
    engine.clearPendingGap()
    await engine.changeMic('mic-1')

    expect(calls.gaps).toEqual([0])
  })

  it('close stops tracks and closes the context', async () => {
    const { ctx } = installAudioGlobals()
    const stream = createStream()
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => stream) } })
    const { engine } = createEngine()

    await engine.init()
    engine.close()

    expect(stream.track.stop).toHaveBeenCalled()
    expect(ctx.close).toHaveBeenCalled()
  })
})
