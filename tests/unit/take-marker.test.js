import { describe, it, expect, vi, afterEach } from 'vitest'
import { createCaptureWriter } from '../../src/lib/recording/capture-writer.js'
import {
  TAKE_MARKER_LEAD_MS,
  TAKE_MARKER_TYPE,
  takeMarkerMessage,
  localTriggerDelayMs,
  scheduleTakeMarker,
  presentTake,
  countdownSeconds,
  createTakeMarker
} from '../../src/lib/recording/take-marker.js'

describe('localTriggerDelayMs', () => {
  it('matches injectClap: delay is triggerAtMs minus (now + offset), floored at 0', () => {
    expect(localTriggerDelayMs(10_250, 0, 10_000)).toBe(250)
    expect(localTriggerDelayMs(10_250, 50, 10_000)).toBe(200)
    expect(localTriggerDelayMs(9_000, 0, 10_000)).toBe(0)
  })

  it('a missing trigger schedules immediately', () => {
    expect(localTriggerDelayMs(null, 0, 10_000)).toBe(0)
    expect(localTriggerDelayMs(undefined, 40, 10_000)).toBe(0)
  })
})

describe('scheduleTakeMarker', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('engine-ready: tone and boundary fire at the same scheduled delay, not on receipt', () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const tones = []
    const boundaries = []
    const result = scheduleTakeMarker({
      triggerAtMs: 10_250,
      offset: 0,
      now: 10_000,
      engineReady: true,
      scheduleTone: (delayMs) => tones.push(delayMs),
      onBoundary: () => boundaries.push(true)
    })
    expect(result).toEqual({ delayMs: 250, pending: false })
    expect(tones).toEqual([250])
    expect(boundaries).toEqual([])
    vi.advanceTimersByTime(249)
    expect(boundaries).toEqual([])
    vi.advanceTimersByTime(1)
    expect(boundaries).toEqual([true])
  })

  it('not-yet-ready engine: does not schedule tone or boundary; caller queues', () => {
    const tones = []
    const boundaries = []
    const result = scheduleTakeMarker({
      triggerAtMs: 10_250,
      offset: 0,
      now: 10_000,
      engineReady: false,
      scheduleTone: (delayMs) => tones.push(delayMs),
      onBoundary: () => boundaries.push(true)
    })
    expect(result).toEqual({ delayMs: 250, pending: true })
    expect(tones).toEqual([])
    expect(boundaries).toEqual([])
  })
})

describe('presentTake', () => {
  it('excludes samples before the marker without shrinking what was written', () => {
    expect(presentTake({
      samplesWritten: 600,
      dataByteCount: 1200,
      startSample: 400
    })).toEqual({
      startSample: 400,
      startByte: 800,
      takeSamples: 200,
      takeBytes: 400
    })
  })

  it('a marker at 0 presents the whole file as the take', () => {
    expect(presentTake({
      samplesWritten: 48000,
      dataByteCount: 96000,
      startSample: 0
    })).toEqual({
      startSample: 0,
      startByte: 0,
      takeSamples: 48000,
      takeBytes: 96000
    })
  })

  it('a capture-writer file is not truncated when the start marker is recorded', async () => {
    const chunks = []
    const writer = createCaptureWriter({
      sampleRate: 48000,
      write: async (buf) => { chunks.push(new Int16Array(buf)) }
    })
    const before = new Int16Array(400)
    before.fill(1)
    writer.writeChunk(before)
    await writer.drain()
    const startSample = writer.samplesWritten
    const after = new Int16Array(200)
    after.fill(2)
    writer.writeChunk(after)
    await writer.stop()

    expect(chunks).toHaveLength(2)
    expect(chunks[0].length).toBe(400)
    expect(chunks[1].length).toBe(200)
    expect(writer.samplesWritten).toBe(600)
    expect(presentTake({
      samplesWritten: writer.samplesWritten,
      dataByteCount: writer.dataByteCount,
      startSample
    })).toEqual({
      startSample: 400,
      startByte: 800,
      takeSamples: 200,
      takeBytes: 400
    })
  })
})

describe('countdownSeconds', () => {
  it('ceils remaining delay to whole seconds and is 0 at/after the instant', () => {
    expect(countdownSeconds(13_000, 0, 10_000)).toBe(3)
    expect(countdownSeconds(10_250, 0, 10_000)).toBe(1)
    expect(countdownSeconds(10_000, 0, 10_000)).toBe(0)
    expect(countdownSeconds(9_000, 0, 10_000)).toBe(0)
  })
})

describe('createTakeMarker', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function setup(overrides = {}) {
    const sent = []
    const tones = []
    let samplesWritten = 100
    const marker = createTakeMarker({
      send: (msg) => sent.push(msg),
      isHost: () => true,
      getWsStatus: () => 'connected',
      getEngineReady: () => true,
      scheduleTone: (delayMs) => tones.push(delayMs),
      getSamplesWritten: () => samplesWritten,
      now: () => Date.now(),
      ...overrides,
      getSamplesWritten: overrides.getSamplesWritten || (() => samplesWritten)
    })
    return {
      marker,
      sent,
      tones,
      setSamplesWritten: (n) => { samplesWritten = n }
    }
  }

  it('a connected host requestStart sends take_marker once even if the signal fires twice', () => {
    const { marker, sent } = setup()
    marker.requestStart({ synced: true })
    marker.requestStart({ synced: true })
    expect(sent).toEqual([takeMarkerMessage()])
  })

  it('a connected guest requestStart does not send and does not schedule locally', () => {
    const tones = []
    const { marker, sent } = setup({
      isHost: () => false,
      scheduleTone: (delayMs) => tones.push(delayMs)
    })
    marker.requestStart({ synced: true })
    marker.requestStart({ synced: true })
    expect(sent).toEqual([])
    expect(tones).toEqual([])
    expect(marker.takeReady).toBe(false)
  })

  it('a connected host with no synced session marks the take locally without a room clap', () => {
    vi.useFakeTimers()
    vi.setSystemTime(5_000)
    const { marker, sent, tones } = setup()
    marker.requestStart({ synced: false })
    expect(sent).toEqual([])
    expect(tones).toEqual([TAKE_MARKER_LEAD_MS])
  })

  it('solo / disconnected requestStart schedules a local marker without sending', () => {
    vi.useFakeTimers()
    vi.setSystemTime(5_000)
    const { marker, sent, tones } = setup({ getWsStatus: () => 'disconnected' })
    marker.requestStart()
    expect(sent).toEqual([])
    expect(tones).toEqual([TAKE_MARKER_LEAD_MS])
    expect(marker.takeReady).toBe(false)
    vi.advanceTimersByTime(TAKE_MARKER_LEAD_MS - 1)
    expect(marker.takeReady).toBe(false)
    vi.advanceTimersByTime(1)
    expect(marker.takeReady).toBe(true)
    expect(marker.startSample).toBe(100)
  })

  it('receive flips takeReady at the scheduled instant and records startSample from confirmed writes', () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const { marker, tones, setSamplesWritten } = setup()
    setSamplesWritten(480)
    marker.receive({ triggerAtMs: 10_250, offset: 0 })
    expect(marker.takeReady).toBe(false)
    expect(marker.startSample).toBe(0)
    expect(tones).toEqual([250])
    setSamplesWritten(960)
    vi.advanceTimersByTime(250)
    expect(marker.takeReady).toBe(true)
    expect(marker.startSample).toBe(960)
  })

  it('a second receive is ignored (trigger-received-once)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const { marker, tones } = setup()
    marker.receive({ triggerAtMs: 10_250, offset: 0 })
    marker.receive({ triggerAtMs: 11_000, offset: 0 })
    expect(tones).toEqual([250])
  })

  it('not-yet-ready engine queues the trigger until onEngineReady, then schedules once', () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    let engineReady = false
    const { marker, tones } = setup({ getEngineReady: () => engineReady })
    marker.receive({ triggerAtMs: 10_250, offset: 40 })
    expect(tones).toEqual([])
    expect(marker.takeReady).toBe(false)
    expect(marker.pending).toBe(true)
    engineReady = true
    vi.setSystemTime(10_050)
    marker.onEngineReady()
    expect(tones).toEqual([160])
    expect(marker.pending).toBe(false)
    vi.advanceTimersByTime(160)
    expect(marker.takeReady).toBe(true)
  })

  it('a start marker that already fired does not block the tail, and the tail leaves the take start alone', () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const tails = []
    const { marker, sent } = setup({ onTail: (info) => tails.push(info) })
    marker.requestStart({ synced: true })
    marker.receive({ triggerAtMs: 10_250, offset: 0 })
    vi.advanceTimersByTime(250)
    expect(marker.startSample).toBe(100)
    sent.length = 0

    marker.requestTail({ synced: true })
    marker.requestTail({ synced: true })
    expect(sent).toEqual([{ type: 'take_marker', edge: 'end' }])
    marker.receive({ triggerAtMs: 12_250, offset: 0, edge: 'end' })
    expect(marker.scheduledTailTriggerAtMs).toBe(12_250)
    expect(marker.scheduledTailOffset).toBe(0)
    vi.advanceTimersByTime(2000)
    expect(tails).toEqual([{ uncertain: false }])
    expect(marker.takeReady).toBe(true)
    expect(marker.startSample).toBe(100)
  })

  it('solo / disconnected requestTail closes locally at now + 2000 without sending', () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const tails = []
    const { marker, sent, tones } = setup({
      getWsStatus: () => 'disconnected',
      onTail: (info) => tails.push(info)
    })
    marker.requestTail({ synced: true })
    expect(sent).toEqual([])
    expect(tones).toEqual([2000])
    vi.advanceTimersByTime(1999)
    expect(tails).toEqual([])
    vi.advanceTimersByTime(1)
    expect(tails).toEqual([{ uncertain: false }])
  })

  it('onEngineReady is a no-op when nothing is pending', () => {
    const { marker, tones } = setup()
    marker.onEngineReady()
    expect(tones).toEqual([])
    expect(marker.takeReady).toBe(false)
  })
})

describe('takeMarkerMessage', () => {
  it('is the take_marker WS payload', () => {
    expect(takeMarkerMessage()).toEqual({ type: TAKE_MARKER_TYPE })
    expect(TAKE_MARKER_TYPE).toBe('take_marker')
  })
})
