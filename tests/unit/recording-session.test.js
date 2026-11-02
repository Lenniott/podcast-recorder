import { describe, it, expect, vi, afterEach } from 'vitest'
import { createRecordingSession } from '../../src/lib/recording/recording-session.js'

const chunk = n => new Int16Array([n, n])
const tick = async () => { for (let i = 0; i < 15; i++) await Promise.resolve() }
function setup(options = {}) {
  const file = { write: vi.fn(async () => {}), seek: vi.fn(async () => {}), close: vi.fn(async () => {}) }
  const upload = { handleChunk: vi.fn(), finish: vi.fn(async () => true) }
  const issues = []
  const stopRequested = vi.fn()
  const session = createRecordingSession({ sampleRate: 48000, file, upload, stopCapture: async () => {},
    onIssue: issue => issues.push(issue), onStopRequested: stopRequested, ...options })
  return { session, file, upload, issues, stopRequested }
}
afterEach(() => vi.useRealTimers())

describe('recording destinations', () => {
  it('keeps the chosen microphone through silence and saves every quiet chunk', async () => {
    const onMicrophoneNeeded = vi.fn(async () => true)
    const ctx = setup({ sampleRate: 10, onMicrophoneNeeded })
    const chunks = [new Int16Array(100), new Int16Array(100).fill(1),
      new Int16Array(10).fill(1000), new Int16Array(100)]
    for (const samples of chunks) {
      ctx.session.writeChunk(samples)
      await tick()
    }
    const result = await ctx.session.stop()
    expect(onMicrophoneNeeded).not.toHaveBeenCalled()
    expect(ctx.stopRequested).not.toHaveBeenCalled()
    expect(ctx.upload.handleChunk.mock.calls.map(([samples]) => [...samples])).toEqual(chunks.map(samples => [...samples]))
    const local = ctx.file.write.mock.calls.slice(0, -1).flatMap(([bytes]) => [...new Int16Array(bytes)])
    expect(local).toEqual(chunks.flatMap(samples => [...samples]))
    expect(result.local).toMatchObject({ saved: true, dataByteCount: 620 })
    expect(result.server.saved).toBe(true)
  })

  it('keeps the local chunk when server submission throws and reports the failed destination', async () => {
    const ctx = setup()
    const error = new Error('upload unavailable')
    ctx.upload.handleChunk.mockImplementation(() => { throw error })
    expect(ctx.session.writeChunk(chunk(7))).toBe(4)
    const result = await ctx.session.stop()
    expect(result.local).toMatchObject({ saved: true, dataByteCount: 4 })
    expect([...new Int16Array(ctx.file.write.mock.calls[0][0])]).toEqual([7, 7])
    expect(ctx.stopRequested).toHaveBeenCalledOnce()
    expect(ctx.issues).toEqual([{
      code: 'save-failed', severity: 'error', destination: 'server',
      message: expect.stringMatching(/\S/), error
    }])
  })

  it.each(['seek', 'write'])('bounds a hung finalization %s and never continues it after timeout', async method => {
    vi.useFakeTimers()
    const ctx = setup({ writeTimeoutMs: 100 })
    ctx.file.abort = vi.fn(async () => {})
    let release
    ctx.file[method].mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const stopped = ctx.session.stop()
    await vi.advanceTimersByTimeAsync(100)
    const result = await stopped
    expect(result.local.saved).toBe(false)
    expect(result.local.error.message).toMatch(/finalization timed out/i)
    expect(result.server.saved).toBe(true)
    expect(ctx.file.abort).toHaveBeenCalledOnce()
    expect(ctx.issues).toEqual([{
      code: 'save-failed', severity: 'error', destination: 'local',
      message: expect.stringMatching(/\S/), error: result.local.error
    }])
    release()
    await tick()
    expect(ctx.file.close).not.toHaveBeenCalled()
    expect(ctx.file.write).toHaveBeenCalledTimes(method === 'seek' ? 0 : 1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports an unconfirmed capture stop while completing destinations and notifying local completion', async () => {
    const error = new Error('worklet did not acknowledge stop')
    const onLocalFinished = vi.fn(() => { throw new Error('observer failed') })
    const ctx = setup({ stopCapture: async () => { throw error }, onLocalFinished })
    ctx.session.writeChunk(chunk(4))
    const result = await ctx.session.stop()
    expect(result.captureError).toBe(error)
    expect(result.local.saved).toBe(true)
    expect(result.server.saved).toBe(true)
    expect(onLocalFinished).toHaveBeenCalledExactlyOnceWith(result.local)
    expect(ctx.issues).toEqual([{
      code: 'capture-stop-failed', severity: 'error', destination: 'capture',
      message: expect.stringMatching(/\S/), error
    }])
  })

  it('reports a rejected server finalization without blocking local completion', async () => {
    const ctx = setup()
    const error = new Error('finalize failed')
    ctx.upload.finish.mockRejectedValue(error)
    const result = await ctx.session.stop()
    expect(result.local.saved).toBe(true)
    expect(result.server).toEqual({ saved: false, error })
    expect(ctx.issues).toEqual([{
      code: 'save-failed', severity: 'error', destination: 'server',
      message: expect.stringMatching(/\S/), error
    }])
  })

  it('submits each chunk to the server while the disk is still pending', async () => {
    const ctx = setup()
    let release
    ctx.file.write.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    ctx.session.writeChunk(chunk(1))
    ctx.session.writeChunk(chunk(2))
    await tick()
    expect(ctx.upload.handleChunk.mock.calls.map(([c]) => [...c])).toEqual([[1, 1], [2, 2]])
    expect(ctx.file.write).toHaveBeenCalledTimes(1)
    release()
    const result = await ctx.session.stop()
    expect(result.local.saved).toBe(true)
    expect(result.server.saved).toBe(true)
  })

  it('stops on a failed local chunk without skipping it, while the server gets the final chunk', async () => {
    let ctx
    ctx = setup({ stopCapture: async () => ctx.session.writeChunk(chunk(3)),
      onStopRequested: () => { void ctx.session.stop() } })
    ctx.file.write.mockRejectedValueOnce(new Error('disk full'))
    ctx.session.writeChunk(chunk(1))
    ctx.session.writeChunk(chunk(2))
    const result = await ctx.session.stop()
    expect(ctx.file.write).toHaveBeenCalledTimes(1)
    expect(ctx.file.close).not.toHaveBeenCalled()
    expect(ctx.upload.handleChunk.mock.calls.map(([c]) => c[0])).toEqual([1, 2, 3])
    expect(ctx.upload.finish).toHaveBeenCalledTimes(1)
    expect(result.local.saved).toBe(false)
    expect(result.server.saved).toBe(true)
    expect(ctx.issues).toHaveLength(1)
  })

  it('a permanent server failure requests Stop once and still finalizes local audio', async () => {
    const ctx = setup()
    ctx.session.writeChunk(chunk(1))
    const issue = { code: 'save-failed', severity: 'error', destination: 'server', message: 'failed' }
    ctx.session.reportIssue(issue)
    ctx.session.reportIssue(issue)
    ctx.upload.finish.mockResolvedValue(false)
    const result = await ctx.session.stop()
    expect(ctx.stopRequested).toHaveBeenCalledTimes(1)
    expect(ctx.file.close).toHaveBeenCalledTimes(1)
    expect(result.local.saved).toBe(true)
    expect(result.server.saved).toBe(false)
  })

  it('a pending server finalization does not prevent local close', async () => {
    const ctx = setup()
    let release
    ctx.upload.finish.mockImplementation(() => new Promise(resolve => { release = resolve }))
    ctx.session.writeChunk(chunk(1))
    const stopped = ctx.session.stop()
    await tick()
    expect(ctx.file.close).toHaveBeenCalledTimes(1)
    release(true)
    await stopped
  })

  it.each(['seek', 'write', 'close'])('reports local %s failure during finalization without blocking the server', async method => {
    const ctx = setup()
    ctx.file[method].mockRejectedValueOnce(new Error('finalization failed'))
    const result = await ctx.session.stop()
    expect(result.local.saved).toBe(false)
    expect(result.server.saved).toBe(true)
    expect(ctx.issues[0]).toMatchObject({ code: 'save-failed', destination: 'local' })
  })

  it('accepts the flush before finalizing, rejects later chunks, and stops only once', async () => {
    let ctx
    ctx = setup({ stopCapture: async () => ctx.session.writeChunk(new Int16Array([7])) })
    const stopped = ctx.session.stop()
    expect(ctx.session.stop()).toBe(stopped)
    await stopped
    expect(ctx.session.writeChunk(chunk(9))).toBe(0)
    expect(ctx.upload.handleChunk).toHaveBeenCalledTimes(1)
    const header = new DataView(ctx.file.write.mock.calls.at(-1)[0])
    expect(header.getUint32(40, true)).toBe(2)
  })

  it('warns about a pending slow write, then stops on a bounded timeout', async () => {
    vi.useFakeTimers()
    const ctx = setup({ slowWriteMs: 1000, writeTimeoutMs: 5000 })
    ctx.file.write.mockImplementationOnce(() => new Promise(() => {}))
    ctx.session.writeChunk(chunk(1))
    await vi.advanceTimersByTimeAsync(1000)
    expect(ctx.issues).toEqual([expect.objectContaining({ code: 'slow-write', severity: 'warning' })])
    expect(ctx.stopRequested).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(4000)
    expect(ctx.stopRequested).toHaveBeenCalledTimes(1)
    expect((await ctx.session.stop()).server.saved).toBe(true)
  })


})

it('a fatal issue stops capture even if the page issue observer throws', async () => {
  const stopCapture = vi.fn(async () => {})
  const ctx = setup({ stopCapture, onStopRequested: () => { throw new Error('UI observer failed') } })
  ctx.session.reportIssue({ code: 'save-failed', destination: 'server', severity: 'error' })
  await ctx.session.stop()
  expect(stopCapture).toHaveBeenCalledTimes(1)
  expect(ctx.file.close).toHaveBeenCalledTimes(1)
})

it('a retake seals the local file without stopping capture', async () => {
  const stopCapture = vi.fn(async () => {})
  const ctx = setup({ stopCapture })
  ctx.session.writeChunk(chunk(1))
  const pending = ctx.session.stop({ capture: false })
  const local = await ctx.session.whenLocalFinished
  expect(local).toMatchObject({ saved: true, dataByteCount: 4 })
  expect(stopCapture).not.toHaveBeenCalled()
  expect(ctx.file.close).toHaveBeenCalledOnce()
  expect(ctx.session.samplesWritten).toBe(2)
  await pending
  expect(stopCapture).not.toHaveBeenCalled()
})
