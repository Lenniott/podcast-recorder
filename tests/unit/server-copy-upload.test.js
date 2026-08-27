import { describe, it, expect, vi, afterEach } from 'vitest'
import { createCaptureWriter } from '../../src/lib/capture-writer.js'
import { createServerCopyUpload } from '../../src/lib/server-copy-upload.js'

const SLUG = 'roomslug01'
const CLIENT_ID = 'client123'

// Every retry test drives fake timers (jitter pinned to its low end via
// Math.random) rather than real delay()s, so the suite stays fast
// regardless of the module's actual backoff durations.
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Drains every pending retry backoff timer (and the microtasks each one
 *  unblocks) under vi.useFakeTimers() — long enough to exhaust this
 *  module's actual retry bound however it's tuned, without the test
 *  needing to know or hardcode that tuning. */
async function flushRetries() {
  await vi.advanceTimersByTimeAsync(120_000)
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

  it('never finalizes once a chunk upload has exhausted its retries and failed', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const fetchImpl = vi.fn((url) => {
      if (String(url).includes('/server-copy/session')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ accepted: true, bytesWritten: 0 }) })
      }
      return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'boom' }) })
    })
    const upload = createServerCopyUpload({ slug: SLUG, clientId: CLIENT_ID, fetchImpl })
    await upload.start()

    upload.handleWritten(i16(100), 0)
    const finishPromise = upload.finish() // waits on whenIdle() through every retry
    await flushRetries()
    const finalized = await finishPromise

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

  it('stops sending further chunks once a chunk POST has exhausted its retries, without throwing', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
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
    await flushRetries()
    const callsAfterFirstChunkGivesUp = calls
    upload.handleWritten(i16(100), 100) // arrives after the failure

    expect(() => upload.handleWritten(i16(100), 200)).not.toThrow()
    await flushRetries()

    // A bounded run of retries for the one chunk that was in flight when
    // this session failed — but nothing at all for chunks queued after
    // failed became true (handleWritten is a no-op once failed).
    expect(callsAfterFirstChunkGivesUp).toBeGreaterThan(1)
    expect(calls).toBe(callsAfterFirstChunkGivesUp)
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

  it('never finalizes after the connection drops mid-upload for good (simulating the participant disconnecting for the whole retry window), and drops any chunk queued afterward', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const fetchImpl = vi.fn((url) => {
      if (String(url).includes('/server-copy/session')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ accepted: true, bytesWritten: 0 }) })
      }
      return Promise.reject(new Error('network down')) // the participant's connection never comes back
    })
    const upload = createServerCopyUpload({ slug: SLUG, clientId: CLIENT_ID, fetchImpl })
    await upload.start()

    upload.handleWritten(i16(100), 0)
    await flushRetries() // retries exhaust; this session gives up for good
    expect(upload.getStatus().failed).toBe(true)

    const finalized = await upload.finish()
    expect(finalized).toBe(false) // permanently incomplete — never resumes, never finalizes

    // No resumable-upload protocol: a chunk queued after the interruption
    // (e.g. the local writer producing more audio while the upload session
    // has already given up) is never sent.
    const chunkCallsBefore = fetchImpl.mock.calls.filter((c) => String(c[0]).includes('/server-copy/chunks')).length
    upload.handleWritten(i16(100), 100)
    await flushRetries()
    const chunkCallsAfter = fetchImpl.mock.calls.filter((c) => String(c[0]).includes('/server-copy/chunks')).length
    expect(chunkCallsAfter).toBe(chunkCallsBefore)
  })
})

describe('createServerCopyUpload — retries a transient failure with backoff', () => {
  it('retries a chunk upload after network errors, then succeeds once the connection recovers', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    let chunkAttempts = 0
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('/server-copy/session')) {
        return { ok: true, status: 200, json: async () => ({ accepted: true, bytesWritten: 0 }) }
      }
      chunkAttempts++
      if (chunkAttempts < 3) throw new Error('network down')
      return { ok: true, status: 200, json: async () => ({ bytesWritten: 200 }) }
    })
    const upload = createServerCopyUpload({ slug: SLUG, clientId: CLIENT_ID, fetchImpl })
    await upload.start()

    upload.handleWritten(i16(100), 0) // 200 bytes
    await flushRetries()

    expect(chunkAttempts).toBe(3)
    expect(upload.getStatus()).toMatchObject({ failed: false, ackedBytes: 200 })
  })

  it('retries a chunk upload after 5xx responses, then succeeds', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    let chunkAttempts = 0
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('/server-copy/session')) {
        return { ok: true, status: 200, json: async () => ({ accepted: true, bytesWritten: 0 }) }
      }
      chunkAttempts++
      if (chunkAttempts < 3) return { ok: false, status: 503, json: async () => ({ error: 'unavailable' }) }
      return { ok: true, status: 200, json: async () => ({ bytesWritten: 200 }) }
    })
    const upload = createServerCopyUpload({ slug: SLUG, clientId: CLIENT_ID, fetchImpl })
    await upload.start()

    upload.handleWritten(i16(100), 0)
    await flushRetries()

    expect(chunkAttempts).toBe(3)
    expect(upload.getStatus()).toMatchObject({ failed: false, ackedBytes: 200 })
  })

  it('retries session-accept (start()) after a network error, then succeeds', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    let attempts = 0
    const fetchImpl = vi.fn(async () => {
      attempts++
      if (attempts < 2) throw new Error('network down')
      return { ok: true, status: 200, json: async () => ({ accepted: true, bytesWritten: 0 }) }
    })
    const upload = createServerCopyUpload({ slug: SLUG, clientId: CLIENT_ID, fetchImpl })

    const startPromise = upload.start()
    await flushRetries()
    const accepted = await startPromise

    expect(accepted).toBe(true)
    expect(attempts).toBe(2)
    expect(upload.getStatus().failed).toBe(false)
  })

  it('retries finalize() after a 502, then succeeds', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    let finalizeAttempts = 0
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('/server-copy/session')) {
        return { ok: true, status: 200, json: async () => ({ accepted: true, bytesWritten: 0 }) }
      }
      if (String(url).includes('/server-copy/finalize')) {
        finalizeAttempts++
        if (finalizeAttempts < 2) return { ok: false, status: 502, json: async () => ({}) }
        return { ok: true, status: 200, json: async () => ({ finalized: true, bytesWritten: 200 }) }
      }
      return { ok: true, status: 200, json: async () => ({ bytesWritten: 200 }) } // chunk endpoint
    })
    const upload = createServerCopyUpload({ slug: SLUG, clientId: CLIENT_ID, fetchImpl })
    await upload.start()
    upload.handleWritten(i16(100), 0)

    const finishPromise = upload.finish()
    await flushRetries()
    const finalized = await finishPromise

    expect(finalized).toBe(true)
    expect(finalizeAttempts).toBe(2)
    expect(upload.getStatus().finalized).toBe(true)
  })

  it('gives up and reaches the permanent failed state once chunk retries are exhausted, bounded rather than infinite', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    let chunkAttempts = 0
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('/server-copy/session')) {
        return { ok: true, status: 200, json: async () => ({ accepted: true, bytesWritten: 0 }) }
      }
      chunkAttempts++
      throw new Error('network down') // never recovers
    })
    const upload = createServerCopyUpload({ slug: SLUG, clientId: CLIENT_ID, fetchImpl })
    await upload.start()

    upload.handleWritten(i16(100), 0)
    await flushRetries()

    // Bounded: a small, fixed number of attempts, not an unbounded retry loop.
    expect(chunkAttempts).toBeGreaterThan(1)
    expect(chunkAttempts).toBeLessThan(20)
    expect(upload.getStatus().failed).toBe(true)
  })

  it('gives up via the elapsed-time bound when individual attempts are slow, before the attempt-count bound would ever be reached', async () => {
    // The previous test only ever exercises RETRY_MAX_ATTEMPTS, because a
    // fast-rejecting fetch reaches 5 attempts long before 20s of backoff
    // delay accumulates. That leaves RETRY_MAX_ELAPSED_MS unexercised — a
    // connection that's technically up but each attempt takes a long time
    // to time out (rather than failing instantly) needs the elapsed-time
    // bound specifically, not the attempt-count one, to ever give up.
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    let chunkAttempts = 0
    const SLOW_ATTEMPT_MS = 6000 // 4 of these alone exceed RETRY_MAX_ELAPSED_MS (20s)
    const fetchImpl = vi.fn((url) => {
      if (String(url).includes('/server-copy/session')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ accepted: true, bytesWritten: 0 }) })
      }
      chunkAttempts++
      return new Promise((_, reject) => setTimeout(() => reject(new Error('slow timeout')), SLOW_ATTEMPT_MS))
    })
    const upload = createServerCopyUpload({ slug: SLUG, clientId: CLIENT_ID, fetchImpl })
    await upload.start()

    upload.handleWritten(i16(100), 0)
    await flushRetries()

    // Stopped well short of the 5-attempt cap — proof it was the 20s
    // elapsed-time bound that ended this, not the attempt-count bound.
    expect(chunkAttempts).toBeLessThan(5)
    expect(chunkAttempts).toBeGreaterThan(1)
    expect(upload.getStatus().failed).toBe(true)
  })

  it('fails a chunk upload immediately on a non-retryable 4xx (expired room), without spending any retry attempts', async () => {
    let chunkAttempts = 0
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('/server-copy/session')) {
        return { ok: true, status: 200, json: async () => ({ accepted: true, bytesWritten: 0 }) }
      }
      chunkAttempts++
      return { ok: false, status: 410, json: async () => ({ error: 'room-unavailable' }) }
    })
    const upload = createServerCopyUpload({ slug: SLUG, clientId: CLIENT_ID, fetchImpl })
    await upload.start()

    upload.handleWritten(i16(100), 0)
    await delay(20) // no fake timers needed — a non-retryable failure never waits on backoff

    expect(chunkAttempts).toBe(1)
    expect(upload.getStatus().failed).toBe(true)
  })

  it('fails session-accept immediately on an explicit rejection (401), without retrying', async () => {
    let attempts = 0
    const fetchImpl = vi.fn(async () => {
      attempts++
      return { ok: false, status: 401, json: async () => ({ accepted: false }) }
    })
    const upload = createServerCopyUpload({ slug: SLUG, clientId: CLIENT_ID, fetchImpl })

    const accepted = await upload.start()

    expect(accepted).toBe(false)
    expect(attempts).toBe(1)
  })
})

describe('createServerCopyUpload — lost-ack reconciliation on chunk retry', () => {
  // The trickiest case: the chunk POST actually succeeded server-side, but
  // its *response* was what got lost (a network blip right as the ack came
  // back). sendWithRetry, seeing only "the fetch rejected", retries the
  // exact same offset — and the server's strict expectedOffset check
  // correctly refuses it as stale (409), since it already has those bytes.
  // Blindly treating that 409 as a failure would wrongly kill a session
  // that actually succeeded; pump() must instead recognize its own bytes
  // are already durably accounted for and move on.
  it('treats a 409 offset-mismatch as success when the server already durably has this exact chunk (lost ack)', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    let attempts = 0
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('/server-copy/session')) {
        return { ok: true, status: 200, json: async () => ({ accepted: true, bytesWritten: 0 }) }
      }
      attempts++
      if (attempts === 1) throw new Error('network down') // request landed, ack was lost
      // Retry re-sends offset=0, but the server already has these 200
      // bytes durably on disk from the "failed" first attempt.
      return { ok: false, status: 409, json: async () => ({ error: 'offset-mismatch', bytesWritten: 200 }) }
    })
    const upload = createServerCopyUpload({ slug: SLUG, clientId: CLIENT_ID, fetchImpl })
    await upload.start()

    upload.handleWritten(i16(100), 0) // 200 bytes
    await flushRetries()

    expect(attempts).toBe(2)
    expect(upload.getStatus()).toMatchObject({ failed: false, ackedBytes: 200, confirmedBytes: 200, progress: 1 })
  })

  it('reconciles a lost ack even when the server offset has moved further ahead than just this chunk', async () => {
    // Not the expected single-writer shape, but sendWithRetry's contract
    // is "the server's real offset already covers what I was retrying" —
    // so a server report of more bytes than this one chunk should still
    // reconcile as success rather than being second-guessed.
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    let attempts = 0
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('/server-copy/session')) {
        return { ok: true, status: 200, json: async () => ({ accepted: true, bytesWritten: 0 }) }
      }
      attempts++
      if (attempts === 1) throw new Error('network down')
      return { ok: false, status: 409, json: async () => ({ error: 'offset-mismatch', bytesWritten: 250 }) }
    })
    const upload = createServerCopyUpload({ slug: SLUG, clientId: CLIENT_ID, fetchImpl })
    await upload.start()

    upload.handleWritten(i16(100), 0) // 200 bytes
    await flushRetries()

    expect(upload.getStatus()).toMatchObject({ failed: false, ackedBytes: 250 })
  })

  it('fails permanently on a 409 offset-mismatch that does NOT cover the retried chunk — a real, unexplained divergence retry cannot fix', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('/server-copy/session')) {
        return { ok: true, status: 200, json: async () => ({ accepted: true, bytesWritten: 0 }) }
      }
      // The server reports fewer bytes than even this chunk's starting
      // offset — not something reconciliation can paper over.
      return { ok: false, status: 409, json: async () => ({ error: 'offset-mismatch', bytesWritten: 0 }) }
    })
    const upload = createServerCopyUpload({ slug: SLUG, clientId: CLIENT_ID, fetchImpl })
    await upload.start()

    upload.handleWritten(i16(100), 0)
    await delay(20) // first attempt gets the 409 directly — no backoff involved

    expect(upload.getStatus().failed).toBe(true)
  })
})

describe('createServerCopyUpload — clientId-owning token (ticket 11)', () => {
  it('includes the token on the session, chunk, and finalize requests when one is provided', async () => {
    const { fetchImpl, calls } = makeFakeFetch()
    const TOKEN = 'the-owning-token'
    const upload = createServerCopyUpload({ slug: SLUG, clientId: CLIENT_ID, sampleRate: 44100, fetchImpl, token: TOKEN })
    await upload.start()

    const sessionCall = calls.find((c) => c.url.includes('/server-copy/session'))
    expect(JSON.parse(sessionCall.init.body)).toMatchObject({ clientId: CLIENT_ID, token: TOKEN })

    upload.handleWritten(i16(10), 0)
    await upload.finish()

    const chunkCall = calls.find((c) => c.url.includes('/server-copy/chunks'))
    expect(chunkCall.url).toContain(`token=${TOKEN}`)

    const finalizeCall = calls.find((c) => c.url.includes('/server-copy/finalize'))
    expect(JSON.parse(finalizeCall.init.body)).toMatchObject({ clientId: CLIENT_ID, token: TOKEN })
  })

  it('degrades gracefully — never throws or hangs — when start() is called before a token has arrived', async () => {
    // Mirrors the real server's behavior once ticket 11 is wired up: no
    // token means authorizeServerCopyRequest rejects with 401, which is
    // just an ordinary not-yet-accepted session to this module — never a
    // throw, never a hang, and it never blocks handleWritten from being
    // called safely afterward (matches the existing "rejected session"
    // fallback behavior covered elsewhere in this file).
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ accepted: false, reason: 'clientid-mismatch' }) }))
    const upload = createServerCopyUpload({ slug: SLUG, clientId: CLIENT_ID, fetchImpl }) // no token

    const accepted = await upload.start()

    expect(accepted).toBe(false)
    expect(() => upload.handleWritten(i16(10), 0)).not.toThrow()
    expect(upload.getStatus().failed).toBe(true)
  })

  it('omits the token param/field entirely (not the literal string "undefined") when none is provided', async () => {
    const { fetchImpl, calls } = makeFakeFetch()
    const upload = createServerCopyUpload({ slug: SLUG, clientId: CLIENT_ID, fetchImpl }) // no token
    await upload.start()
    upload.handleWritten(i16(10), 0)
    await delay(20)

    const sessionCall = calls.find((c) => c.url.includes('/server-copy/session'))
    expect(JSON.parse(sessionCall.init.body)).not.toHaveProperty('token')

    const chunkCall = calls.find((c) => c.url.includes('/server-copy/chunks'))
    expect(chunkCall.url).not.toContain('token=')
  })
})

describe('createServerCopyUpload — no resumability across instances (rejoin does not continue a stale attempt)', () => {
  it('a fresh instance for the same room/clientId starts from a clean slate, independent of a previous failed one', async () => {
    // What startRecording() does on every new take/rejoin (see ticket 08):
    // create a brand-new createServerCopyUpload() instance rather than
    // reusing or resuming a prior one. There is no shared module-level
    // state, so a failed first instance can never leak into or block a
    // second, later instance for the same slug/clientId.
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const failingFetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }))
    const first = createServerCopyUpload({ slug: SLUG, clientId: CLIENT_ID, fetchImpl: failingFetch })
    const startPromise = first.start() // retries the session-accept 5xx before giving up
    await flushRetries()
    await startPromise
    first.handleWritten(i16(10), 0)
    expect(first.getStatus().failed).toBe(true)

    const { fetchImpl: freshFetch } = makeFakeFetch()
    const second = createServerCopyUpload({ slug: SLUG, clientId: CLIENT_ID, fetchImpl: freshFetch })

    expect(second.getStatus()).toMatchObject({
      accepted: false,
      failed: false,
      finalized: false,
      ackedBytes: 0,
      confirmedBytes: 0
    })
    const accepted = await second.start()
    expect(accepted).toBe(true)
    expect(second.getStatus().failed).toBe(false)
  })
})
