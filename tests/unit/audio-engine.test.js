import { describe, it, expect, afterEach, vi } from 'vitest'
import { createAudioEngine } from '../../src/lib/recording/audio-engine.js'

function createTrack(label = 'Input') {
  return { label, onended: null, stop: vi.fn(), applyConstraints: vi.fn(async () => {}) }
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
    onIssue: (issue) => calls.gaps.push(issue),
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
      audio: { deviceId: { exact: 'mic-1' } }
    })
    expect(calls.micConnected).toHaveBeenCalledOnce()
    expect(calls.gaps).toEqual([])
    expect(engine.sampleRate).toBe(44100)
    expect(engine.getAnalyserNode().fftSize).toBe(2048)

    const buffer = new Float32Array([0.1, -0.1])
    workletNode.port.onmessage({ data: { type: 'level', rms: 0.2, peak: 0.5 } })
    engine.startCapture()
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
    calls.setSelectedDeviceId.mockClear()
    await engine.switchToBestMic()

    expect(calls.loadDevices).toHaveBeenCalledOnce()
    expect(calls.setMicFallback).toHaveBeenCalledWith(false)
    expect(calls.setSelectedDeviceId).toHaveBeenCalledWith('mic-1')
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
    await engine.switchToBestMic()

    expect(calls.setSelectedDeviceId).toHaveBeenCalledWith('mic-2')
    expect(calls.setMicFallback).toHaveBeenCalledWith(true)
    expect(calls.setMicFallbackName).toHaveBeenCalledWith('Backup Mic')
  })

  it('reports no available mic when every listed input fails', async () => {
    installAudioGlobals()
    const getUserMedia = vi.fn().mockResolvedValueOnce(createStream('Mic 1')).mockRejectedValue(new Error('no input'))
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
    const { engine, calls } = createEngine()
    await engine.init()
    expect(await engine.switchToBestMic()).toBe(false)
    expect(calls.gaps).toEqual([expect.objectContaining({ code: 'mic-disconnected' })])
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

describe('capture start/stop protocol', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
  it('waits for worklet acknowledgement and delivers the final chunk first', async () => {
    const { workletNode } = installAudioGlobals()
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => createStream()) } })
    const { engine, calls } = createEngine()
    await engine.init()
    engine.startCapture()
    const stopped = engine.stopCapture()
    expect(engine.stopCapture()).toBe(stopped)
    const request = workletNode.port.postMessage.mock.calls.at(-1)[0]
    const buffer = new Float32Array([0.5])
    workletNode.port.onmessage({ data: { type: 'data', buffer } })
    expect(calls.chunks).toEqual([buffer])
    workletNode.port.onmessage({ data: { type: 'stopped', id: request.id } })
    await stopped
    workletNode.port.onmessage({ data: { type: 'data', buffer } })
    expect(calls.chunks).toHaveLength(1)
  })

  it('reports suspension and rejects Stop when the processor never acknowledges', async () => {
    vi.useFakeTimers()
    const { ctx } = installAudioGlobals()
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => createStream()) } })
    const { engine, calls } = createEngine()
    await engine.init()
    engine.startCapture()
    ctx.state = 'suspended'
    ctx.onstatechange()
    expect(calls.gaps).toEqual([expect.objectContaining({ code: 'audio-suspended' })])
    const stopped = expect(engine.stopCapture()).rejects.toThrow('final chunk may be missing')
    await vi.advanceTimersByTimeAsync(3000)
    await stopped
  })
})

it('asks once for a microphone while none is connected', async () => {
  installAudioGlobals()
  let stream
  const getUserMedia = vi.fn(async () => {
    if (!stream) {
      stream = createStream('Mic 1')
      return stream
    }
    throw new Error('no input')
  })
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  try {
    const { engine } = createEngine()
    await engine.init()
    await engine.requestMicrophone()
    expect(getUserMedia).toHaveBeenCalledTimes(1)

    stream.track.onended()
    for (let i = 0; i < 10; i++) await Promise.resolve()
    await engine.requestMicrophone()
    expect(getUserMedia).toHaveBeenCalledTimes(2)
  } finally { vi.unstubAllGlobals() }
})

it('quiet audio never reconnects; an ended track does', async () => {
  const { workletNode } = installAudioGlobals()
  const stream = createStream()
  const getUserMedia = vi.fn(async () => stream)
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  try {
    const { engine } = createEngine()
    await engine.init()
    engine.startCapture()
    workletNode.port.onmessage({ data: { type: 'level', rms: 0, peak: 0 } })
    workletNode.port.onmessage({ data: { type: 'data', buffer: new Float32Array(8192) } })
    expect(getUserMedia).toHaveBeenCalledTimes(1)
    stream.track.onended()
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(getUserMedia).toHaveBeenCalledTimes(2)
  } finally { vi.unstubAllGlobals() }
})

it('keeps the working microphone connected when opening a replacement fails', async () => {
  installAudioGlobals()
  const stream = createStream('Working')
  const getUserMedia = vi.fn().mockResolvedValueOnce(stream).mockRejectedValueOnce(new Error('broken input'))
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  try {
    const { engine, calls } = createEngine()
    await engine.init()
    await engine.changeMic('broken')
    expect(stream.track.stop).not.toHaveBeenCalled()
    expect(engine.micConnected).toBe(true)
    expect(calls.gaps).toEqual([expect.objectContaining({ code: 'mic-disconnected' })])
  } finally { vi.unstubAllGlobals() }
})

it('refreshing the device list probes new inputs without switching away from a working mic', async () => {
  vi.useFakeTimers()
  installAudioGlobals()
  const current = createStream('Current')
  const added = createStream('Added')
  const getUserMedia = vi.fn().mockResolvedValueOnce(current).mockResolvedValue(added)
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  try {
    const devices = [{ deviceId: 'mic-1', label: 'Current' }]
    const { engine, calls } = createEngine({ devices })
    await engine.init()
    devices.push({ deviceId: 'mic-2', label: 'Added' })
    const refreshed = engine.refreshMicrophones()
    await vi.runAllTimersAsync()
    await refreshed
    expect(current.track.stop).not.toHaveBeenCalled()
    expect(calls.micConnected).toHaveBeenCalledTimes(1)
    expect(added.track.stop).toHaveBeenCalledTimes(1)
    expect(engine.micConnected).toBe(true)
  } finally { vi.unstubAllGlobals(); vi.useRealTimers() }
})
