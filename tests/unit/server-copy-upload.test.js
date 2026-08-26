import { describe, it, expect, vi } from 'vitest'
import { createCaptureWriter } from '../../src/lib/capture-writer.js'
import { createServerCopyUpload } from '../../src/lib/server-copy-upload.js'

const SLUG = 'roomslug01'
const CLIENT_ID = 'client123'

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function i16(n, fill = 1) {
  const arr = new Int16Array(n)
  arr.fill(fill)
  return arr
}

/** A fetch double that accepts a session, every chunk, and finalize
 *  immediately, tracking bytes it has "received" per clientId like the
 *  real endpoints. */
function makeFakeFetch() {
  let bytesAcked = 0
  const calls = []
  const fetchImpl = vi.fn(async (url, init) => {
    calls.push({ url: String(url), init })
    if (String(url).includes('/server-copy/session')) {
      return { ok: true, status: 200, json: async () => ({ accepted: true, bytesWritten: bytesAcked }) }
    }
    if (String(url).includes('/server-copy/finalize')) {
      return { ok: true, status: 200, json: async () => ({ finalized: true, bytesWritten: bytesAcked }) }
    }
    const body = init.body
    const len = body.byteLength ?? body.length
    bytesAcked += len
    return { ok: true, status: 200, json: async () => ({ bytesWritten: bytesAcked }) }
  })
  return { fetchImpl, calls, get bytesAcked() { return bytesAcked } }
}

describe('createServerCopyUpload — gated by session acceptance', () => {
  it('does not send any chunk bytes before start() has been accepted', async () => {
    let resolveSession
    const fetchImpl = vi.fn((url) => {
      if (String(url).includes('/server-copy/session')) {
        return new Promise((resolve) => { resolveSession = resolve })
      }
      throw new Error('must not upload a chunk before the session is accepted')
    })
    const upload = createServerCopyUpload({ slug: SLUG, clientId: CLIENT_ID, fetchImpl })

    const startPromise = upload.start()
    upload.handleWritten(i16(4), 0) // recording already producing confirmed chunks
    await delay(20)

    expect(fetchImpl).toHaveBeenCalledTimes(1) // only the session request so far

    resolveSession({ ok: true, status: 200, json: async () => ({ accepted: true, bytesWritten: 0 }) })
    await startPromise
    await delay(20)

    expect(fetchImpl).toHaveBeenCalledTimes(2) // now the queued chunk went out
  })

  it('never sends a chunk when the session is rejected (expired/deleted room)', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('/server-copy/session')) {
        return { ok: false, status: 410, json: async () => ({ accepted: false, reason: 'room-unavailable' }) }
      }
      throw new Error('must not upload a chunk after session rejection')
    })
    const upload = createServerCopyUpload({ slug: SLUG, clientId: CLIENT_ID, fetchImpl })

    const accepted = await upload.start()
    upload.handleWritten(i16(4), 0)
    await delay(20)

    expect(accepted).toBe(false)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(upload.getStatus().failed).toBe(true)
  })
})

describe('createServerCopyUpload — only uploads chunks the local writer has confirmed', () => {
  it('queues and sends real capture-writer chunks in write order, via handleWritten as onWritten', async () => {
    const { fetchImpl, calls } = makeFakeFetch()
    const upload = createServerCopyUpload({ slug: SLUG, clientId: CLIENT_ID, fetchImpl })
    await upload.start()

    const written = []
    const writer = createCaptureWriter({
      sampleRate: 48000,
      write: async (buf) => { written.push(new Int16Array(buf)) },
      onWritten: upload.handleWritten
    })

    writer.writeChunk(i16(100, 1))
    writer.writeChunk(i16(100, 2))
    await writer.stop()
    await delay(20)

    const chunkCalls = calls.filter((c) => c.url.includes('/server-copy/chunks'))
    expect(chunkCalls.length).toBe(2)
    expect(chunkCalls[0].url).toContain('offset=0')
    expect(chunkCalls[1].url).toContain('offset=200') // 100 samples * 2 bytes
    expect(upload.getStatus().ackedBytes).toBe(400)
  })
})

describe('createServerCopyUpload — progress tracking', () => {
  it('reports acknowledged-server-bytes / confirmed-local-bytes, not wall-clock time', async () => {
    const { fetchImpl } = makeFakeFetch()
    const upload = createServerCopyUpload({ slug: SLUG, clientId: CLIENT_ID, fetchImpl })
    await upload.start()

    expect(upload.getStatus().progress).toBe(0) // nothing confirmed yet

    upload.handleWritten(i16(100), 0)
    await delay(20)
    expect(upload.getStatus()).toMatchObject({ confirmedBytes: 200, ackedBytes: 200, progress: 1 })
  })

  it('shows partial progress while a chunk is still in flight, not 0% or 100%', async () => {
    let releaseChunk
    const fetchImpl = vi.fn((url) => {
      if (String(url).includes('/server-copy/session')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ accepted: true, bytesWritten: 0 }) })
      }
      return new Promise((resolve) => { releaseChunk = () => resolve({ ok: true, status: 200, json: async () => ({ bytesWritten: 100 }) }) })
    })
    const upload = createServerCopyUpload({ slug: SLUG, clientId: CLIENT_ID, fetchImpl })
    await upload.start()

    upload.handleWritten(i16(100), 0) // 200 confirmed bytes, in flight
    await delay(20)

    expect(upload.getStatus()).toMatchObject({ confirmedBytes: 200, ackedBytes: 0 })

    releaseChunk()
    await delay(20)
    expect(upload.getStatus().ackedBytes).toBe(100)
  })

  it('can report 100% mid-recording on a fast connection without special-casing', async () => {
    const { fetchImpl } = makeFakeFetch()
    const upload = createServerCopyUpload({ slug: SLUG, clientId: CLIENT_ID, fetchImpl })
    await upload.start()

    upload.handleWritten(i16(50), 0)
    await delay(10)
    upload.handleWritten(i16(50), 50)
    await delay(10)

    expect(upload.getStatus().progress).toBe(1)
  })
})

describe('createServerCopyUpload — finalize signal', () => {
  it('waits for all queued chunks to be acked, then sends the confirmed total as the explicit final length', async () => {
    const { fetchImpl, calls } = makeFakeFetch()
    const upload = createServerCopyUpload({ slug: SLUG, clientId: CLIENT_ID, sampleRate: 44100, fetchImpl })
    await upload.start()

    upload.handleWritten(i16(100), 0) // 200 confirmed bytes
    const finalized = await upload.finish()

    expect(finalized).toBe(true)
    const finalizeCall = calls.find((c) => c.url.includes('/server-copy/finalize'))
    expect(finalizeCall).toBeTruthy()
    expect(JSON.parse(finalizeCall.init.body)).toEqual({ clientId: CLIENT_ID, totalBytes: 200, sampleRate: 44100 })
    expect(upload.getStatus().finalized).toBe(true)
  })

  it('never finalizes before in-flight chunks have actually been acked', async () => {
    let releaseChunk
    const fetchImpl = vi.fn((url) => {
      if (String(url).includes('/server-copy/session')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ accepted: true, bytesWritten: 0 }) })
      }
      if (String(url).includes('/server-copy/finalize')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ finalized: true }) })
      }
      return new Promise((resolve) => {
        releaseChunk = () => resolve({ ok: true, status: 200, json: async () => ({ bytesWritten: 200 }) })
      })
    })
    const upload = createServerCopyUpload({ slug: SLUG, clientId: CLIENT_ID, fetchImpl })
    await upload.start()

    upload.handleWritten(i16(100), 0) // chunk still in flight
    let finished = false
    const finishPromise = upload.finish().then(() => { finished = true })
    await delay(20)

    expect(finished).toBe(false) // must not finalize while a chunk is still unacked
    expect(fetchImpl.mock.calls.some((c) => String(c[0]).includes('/server-copy/finalize'))).toBe(false)

    releaseChunk()
    await finishPromise
    expect(finished).toBe(true)
  })

  it('never finalizes when the session was rejected — finish() reports failure instead of hanging', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 410, json: async () => ({ accepted: false }) }))
    const upload = createServerCopyUpload({ slug: SLUG, clientId: CLIENT_ID, fetchImpl })
    await upload.start()

    const finalized = await upload.finish()

    expect(finalized).toBe(false)
  })

  it('never finalizes once a chunk upload has failed', async () => {
    const fetchImpl = vi.fn((url) => {
      if (String(url).includes('/server-copy/session')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ accepted: true, bytesWritten: 0 }) })
      }
      return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'boom' }) })
    })
    const upload = createServerCopyUpload({ slug: SLUG, clientId: CLIENT_ID, fetchImpl })
    await upload.start()

    upload.handleWritten(i16(100), 0)
    await delay(20)

    const finalized = await upload.finish()
    expect(finalized).toBe(false)
    expect(fetchImpl.mock.calls.some((c) => String(c[0]).includes('/server-copy/finalize'))).toBe(false)
  })

  it('is idempotent — calling finish() again after a successful finalize does not re-request it', async () => {
    const { fetchImpl, calls } = makeFakeFetch()
    const upload = createServerCopyUpload({ slug: SLUG, clientId: CLIENT_ID, fetchImpl })
    await upload.start()
    upload.handleWritten(i16(10), 0)
    await upload.finish()

    const finalizeCallsBefore = calls.filter((c) => c.url.includes('/server-copy/finalize')).length
    await upload.finish()
    const finalizeCallsAfter = calls.filter((c) => c.url.includes('/server-copy/finalize')).length

    expect(finalizeCallsAfter).toBe(finalizeCallsBefore)
  })
})

describe('createServerCopyUpload — a slow or failing upload never affects local recording', () => {
  it('a hung chunk POST never delays writeChunk()/stop() on the local writer', async () => {
    const fetchImpl = vi.fn((url) => {
      if (String(url).includes('/server-copy/session')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ accepted: true, bytesWritten: 0 }) })
      }
      return new Promise(() => {}) // hangs forever — simulates a stalled upload
    })
    const upload = createServerCopyUpload({ slug: SLUG, clientId: CLIENT_ID, fetchImpl })
    await upload.start()

    const written = []
    const writer = createCaptureWriter({
      sampleRate: 48000,
      write: async (buf) => { written.push(new Int16Array(buf)) },
      onWritten: upload.handleWritten
    })

    writer.writeChunk(i16(100))
    writer.writeChunk(i16(100))
    const start = Date.now()
    const result = await writer.stop()
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(500)
    expect(written.length).toBe(2)
    expect(result.samplesWritten).toBe(200)
  })

  it('a chunk POST that rejects does not throw back into the local writer or stop later local writes', async () => {
    const fetchImpl = vi.fn((url) => {
      if (String(url).includes('/server-copy/session')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ accepted: true, bytesWritten: 0 }) })
      }
      return Promise.reject(new Error('network down'))
    })
    const upload = createServerCopyUpload({ slug: SLUG, clientId: CLIENT_ID, fetchImpl })
    await upload.start()

    const written = []
    const writer = createCaptureWriter({
      sampleRate: 48000,
      write: async (buf) => { written.push(new Int16Array(buf)) },
      onWritten: upload.handleWritten
    })

    writer.writeChunk(i16(100, 1))
    writer.writeChunk(i16(100, 2))
    writer.writeChunk(i16(100, 3))
    const result = await writer.stop()

    expect(written.length).toBe(3) // all real chunks still hit local disk
    expect(result.samplesWritten).toBe(300)
  })

  it('stops sending further chunks once a chunk POST has failed, without throwing', async () => {
    let calls = 0
    const fetchImpl = vi.fn((url) => {
      if (String(url).includes('/server-copy/session')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ accepted: true, bytesWritten: 0 }) })
      }
      calls++
      return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'boom' }) })
    })
    const upload = createServerCopyUpload({ slug: SLUG, clientId: CLIENT_ID, fetchImpl })
    await upload.start()

    upload.handleWritten(i16(100), 0)
    await delay(20)
    upload.handleWritten(i16(100), 100) // arrives after the failure

    expect(() => upload.handleWritten(i16(100), 200)).not.toThrow()
    await delay(20)

    expect(calls).toBe(1) // no retry, no further attempts once failed
    expect(upload.getStatus().failed).toBe(true)
  })

  it('a rejected session-start still allows later handleWritten calls to be safely ignored', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ accepted: false }) }))
    const upload = createServerCopyUpload({ slug: SLUG, clientId: CLIENT_ID, fetchImpl })
    await upload.start()

    expect(() => upload.handleWritten(i16(10), 0)).not.toThrow()
    await delay(10)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
