import { describe, it, expect, vi, afterEach } from 'vitest'
import { createServerCopyUpload } from '../../src/lib/server-copy-upload.js'
import { deriveServerCopyUploadState, shouldAnnounceServerCopyFailure } from '../../src/lib/server-copy-status.js'
import { isIncompleteServerCopyUpload } from '../../src/lib/exit-guard.js'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// These tests exercise the exact chain the room page wires together for the
// post-stop blocking modal (ticket 07): serverCopyUpload's real onProgress
// callbacks -> deriveServerCopyUploadState (shared vocabulary, server-copy-status.js)
// -> isIncompleteServerCopyUpload (exit-guard.js) -> "is the modal open" =
// recordingState === 'idle' && incomplete. Nothing here is a reimplementation
// of the page's logic — it's the same functions the page imports.

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

/** Mirrors how +page.svelte derives modal visibility from live state. */
function deriveModalOpen({ recordingState, uploadStatus }) {
  const uploadState = deriveServerCopyUploadState(uploadStatus, { isRecording: recordingState === 'recording' })
  return recordingState === 'idle' && isIncompleteServerCopyUpload(uploadState)
}

describe('post-stop upload-wait modal — open/closed derivation', () => {
  it('is not open while still recording, even with an incomplete upload', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('/server-copy/session')) {
        return { ok: true, status: 200, json: async () => ({ accepted: true, bytesWritten: 0 }) }
      }
      return new Promise(() => {}) // chunk stays in flight forever for this test
    })
    let recordingState = 'recording'
    let modalOpen = false
    const upload = createServerCopyUpload({
      slug: SLUG,
      clientId: CLIENT_ID,
      fetchImpl,
      onProgress: (status) => { modalOpen = deriveModalOpen({ recordingState, uploadStatus: status }) }
    })
    await upload.start()

    upload.handleWritten(i16(100))
    await delay(10)

    expect(modalOpen).toBe(false)
  })

  it('opens once recording goes idle with the copy still catching up, and auto-closes the instant finalize confirms completion', async () => {
    let releaseChunk
    let releaseFinalize
    const fetchImpl = vi.fn((url) => {
      const u = String(url)
      if (u.includes('/server-copy/session')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ accepted: true, bytesWritten: 0 }) })
      }
      if (u.includes('/server-copy/finalize')) {
        return new Promise((resolve) => {
          releaseFinalize = () => resolve({ ok: true, status: 200, json: async () => ({ finalized: true }) })
        })
      }
      return new Promise((resolve) => {
        releaseChunk = () => resolve({ ok: true, status: 200, json: async () => ({ bytesWritten: 200 }) })
      })
    })

    let recordingState = 'recording'
    let modalOpen = false
    const upload = createServerCopyUpload({
      slug: SLUG,
      clientId: CLIENT_ID,
      fetchImpl,
      onProgress: (status) => { modalOpen = deriveModalOpen({ recordingState, uploadStatus: status }) }
    })
    await upload.start()

    upload.handleWritten(i16(100)) // chunk in flight
    await delay(10)
    expect(modalOpen).toBe(false) // still recording — sidebar shows progress, no blocking modal yet

    // Local WAV finalized, recording fully stopped.
    recordingState = 'idle'
    releaseChunk()
    await delay(10)
    expect(modalOpen).toBe(true) // local file is safe; server copy is still catching up

    const finishPromise = upload.finish()
    await delay(10)
    expect(modalOpen).toBe(true) // finalize request in flight — still incomplete

    releaseFinalize()
    await finishPromise
    expect(modalOpen).toBe(false) // finalized — modal auto-closes the instant completion is confirmed
  })

  it('never opens when the local recording never had an incomplete upload to begin with', () => {
    const modalOpen = deriveModalOpen({ recordingState: 'idle', uploadStatus: null })
    expect(modalOpen).toBe(false)
  })
})

// Ticket 08: once a copy has permanently failed, isIncompleteServerCopyUpload
// is deliberately false for it (see exit-guard.js) — nothing left to wait
// for — so the modal above closes exactly as if the copy had finished. This
// pins down the page's other reaction to that same transition: a one-time
// explanation ($lib/server-copy-status.js's shouldAnnounceServerCopyFailure)
// so a failure is never left completely unremarked once the modal is gone.
describe('post-stop server-copy failure notice — fires exactly where the wait modal goes silent', () => {
  it('announces once the copy fails and recording has already stopped — right when the wait modal would otherwise just vanish', async () => {
    // Ticket 09: a 500 is now retried with backoff before this session
    // gives up, so this test drives fake timers through that retry
    // window rather than assuming the very first 500 is already final.
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const fetchImpl = vi.fn((url) => {
      if (String(url).includes('/server-copy/session')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ accepted: true, bytesWritten: 0 }) })
      }
      return Promise.resolve({ ok: false, status: 500, json: async () => ({}) })
    })
    let recordingState = 'recording'
    let lastStatus = null
    let modalOpen = false
    let announced = false
    // Mirrors +page.svelte's `$: ...` reactive statements, which re-run on
    // ANY referenced dependency changing — not only on a fresh onProgress
    // event. recordingState flipping to 'idle' on its own (with no further
    // chunk activity, exactly like a copy that already gave up) must still
    // trigger this recomputation, same as it would in the real component.
    function recompute() {
      const uploadState = deriveServerCopyUploadState(lastStatus, { isRecording: recordingState === 'recording' })
      modalOpen = recordingState === 'idle' && isIncompleteServerCopyUpload(uploadState)
      if (shouldAnnounceServerCopyFailure({ recordingState, uploadState, announced })) announced = true
    }
    const upload = createServerCopyUpload({
      slug: SLUG,
      clientId: CLIENT_ID,
      fetchImpl,
      onProgress: (status) => {
        lastStatus = status
        recompute()
      }
    })
    await upload.start()

    upload.handleWritten(i16(100))
    await vi.advanceTimersByTimeAsync(120_000) // drain every retry backoff; the chunk never recovers
    expect(announced).toBe(false) // still recording — never interrupts an active take

    recordingState = 'idle' // the copy already failed while recording; only this changes now
    recompute()

    expect(modalOpen).toBe(false) // failed is not "incomplete" — the wait modal itself stays closed
    expect(announced).toBe(true) // ...but the failure is still explicitly surfaced, exactly once
  })
})
