/**
 * Server-copy upload — mirrors confirmed-written local audio to the server
 * as a convenience copy, entirely downstream of local recording.
 *
 * This is the "future upload mirror" that capture-writer.js's `onWritten`
 * seam (see ticket 03) was hardened for: `handleWritten` is meant to be
 * passed straight in as `createCaptureWriter({ onWritten: upload.handleWritten })`,
 * or chained after another observer. It must never be attached to the live
 * mic signal, elapsed time, or WebRTC media — only to chunks the local
 * writer has already confirmed written. Because capture-writer never
 * awaits or lets onWritten's failures propagate, this module doesn't need
 * its own defenses against blocking or corrupting the local write path —
 * it inherits that guarantee. What it does still guard itself is (a) never
 * sending bytes before its own session is accepted, and (b) never letting
 * a slow/hung/failed HTTP request pile up unbounded retries or memory.
 *
 * Transport: plain HTTP, deliberately not the room WebSocket
 * ($lib/room-connection.js). Reasons:
 *   - Chunk payloads are raw PCM bytes; the WS protocol
 *     ($lib/server/ws-rooms.js) is JSON-only today, so binary chunks would
 *     need a new framing scheme grafted on. A POST body needs none.
 *   - A server-copy session's state is nothing but "how many bytes are
 *     durably on disk for this participant" — see
 *     $lib/server/server-copy-storage.js. That question is answered fresh
 *     by every request, so it never depends on any one WebSocket
 *     connection surviving. There is deliberately no state here that
 *     would need to re-announce itself via room.registerResync() on a WS
 *     reconnect, unlike `recording` — a WS blip during upload simply has
 *     no effect on this module at all.
 *   - HTTP failure/retry semantics (a rejected fetch, a non-2xx status)
 *     are simple to reason about per chunk, without inventing anything on
 *     top of the room socket's own backoff/reconnect handling.
 *
 * Progress is always acknowledged-server-bytes / confirmed-local-bytes —
 * both are byte counters advanced only by confirmed events (a local write
 * resolving, a server ack), never by wall-clock time.
 *
 * A chunk upload, session-accept, or finalize request that fails
 * transiently (a network error, a timeout, a 5xx) is retried with
 * backoff — see RETRY_MAX_ATTEMPTS / RETRY_MAX_ELAPSED_MS below — before
 * this session gives up. A 4xx that reflects real, permanent state (an
 * explicitly rejected session, an expired/deleted room, a malformed
 * request) is never retried: it fails on the very first attempt, same as
 * before this module had retries at all. Once retries are exhausted, or
 * a non-retryable failure is seen, this session gives up permanently —
 * per design, there is no resumable upload (see ticket 08): the server
 * copy is simply left incomplete, and the local WAV remains the
 * fallback. See sendWithRetry()'s doc comment for how a chunk retry
 * reconciles with the server's real offset rather than assuming its own
 * retried request was the first to ever reach the server.
 *
 * `finish()` is the explicit "the local recording's FINAL length is now
 * known" signal (ticket 05) — call it once, after the local writer's
 * stop() has resolved, never on the upload connection merely going idle
 * or a timer. It waits for every chunk handleWritten has queued so far to
 * finish uploading, then asks the server to finalize using this module's
 * own `confirmedBytes` total (the same authoritative counter
 * handleWritten has been accumulating all along, so there's no separate
 * "final length" value that could ever disagree with it) plus the
 * `sampleRate` the recording actually ran at, so the server can build a
 * WAV header that matches. Resolves `true` only once the server confirms
 * the copy is complete — never while chunks are still in flight, and
 * never after this session has already failed.
 */

/**
 * Retry tuning for a transient chunk/session/finalize failure (network
 * error, timeout, or 5xx) — bounded in both attempt count and total
 * elapsed time, so a session that's actually dead (not just having a bad
 * few seconds) still reaches the permanent failed state in well under a
 * minute rather than retrying forever. Exponential backoff with equal
 * jitter, the same shape as room-connection.js's WS reconnect backoff —
 * reimplemented locally rather than imported, since this module is
 * deliberately independent of the room socket (see the transport note
 * in the module doc comment above).
 */
const RETRY_MAX_ATTEMPTS = 5
const RETRY_MAX_ELAPSED_MS = 20_000
const RETRY_BASE_DELAY_MS = 1000
const RETRY_CAP_DELAY_MS = 8000

function backoffDelayMs(attempt) {
  const exp = Math.min(RETRY_CAP_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1))
  return exp * (0.5 + Math.random() * 0.5)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRetryableStatus(status) {
  return status >= 500 && status <= 599
}

/**
 * Runs one HTTP round trip via `sendRequest()`, retrying with backoff on
 * a transient failure — a rejected fetch (network error/timeout) or a
 * 5xx response — up to RETRY_MAX_ATTEMPTS times or RETRY_MAX_ELAPSED_MS
 * total elapsed, whichever comes first. Any other outcome (a successful
 * response, or a non-retryable non-OK one) is returned immediately
 * without spending further attempts: a 400/401/409/410 reflects real,
 * permanent state a blind retry can't fix. Callers that need to look
 * closer at a particular non-retryable status before accepting that
 * still get the raw Response to inspect — see pump()'s handling of the
 * chunk endpoint's 409 below, which is "permanent" only in the sense
 * that resending the exact same request won't help; the chunk itself
 * may already be safely on the server, which pump() checks for by hand
 * rather than this generic helper trying to guess.
 *
 * Never throws: a fetch rejection that survives every attempt resolves
 * to `{ error }` rather than rejecting, so every caller gets a plain
 * `{ res } | { error }` to branch on instead of needing its own
 * try/catch around this.
 */
async function sendWithRetry(sendRequest) {
  const startedAt = Date.now()
  for (let attempt = 1; ; attempt++) {
    let res
    let error
    try {
      res = await sendRequest()
    } catch (e) {
      error = e
    }

    const retryable = error ? true : isRetryableStatus(res.status)
    const exhausted = attempt >= RETRY_MAX_ATTEMPTS || Date.now() - startedAt >= RETRY_MAX_ELAPSED_MS
    if (!retryable || exhausted) {
      return error ? { error } : { res }
    }
    await sleep(backoffDelayMs(attempt))
  }
}

export function createServerCopyUpload({ slug, clientId, sampleRate, fetchImpl = fetch, onProgress, token } = {}) {
  if (!slug) throw new Error('createServerCopyUpload: slug is required')
  if (!clientId) throw new Error('createServerCopyUpload: clientId is required')
  // `token` (ticket 11) is the clientId-owning capability token the WS
  // room server hands back on 'join' — see $lib/server/auth.js's
  // makeServerCopyToken doc comment. It's intentionally optional here,
  // not asserted like slug/clientId above: a caller starting an upload
  // before its own join has round-tripped simply has no token yet, and
  // that must degrade gracefully (the server rejects the session request
  // for real, same as any other not-yet-accepted session — see start()),
  // never throw synchronously here.

  let accepted = false
  let failed = false
  let finalized = false
  let ackedBytes = 0
  let confirmedBytes = 0
  const queue = [] // ArrayBuffers awaiting upload, oldest-first
  let sending = false
  let idleWaiters = [] // resolvers waiting for the queue to fully drain

  function fail(error) {
    failed = true
    queue.length = 0
    reportProgress(error)
  }

  function notifyIdleWaiters() {
    if (queue.length > 0 || sending) return
    const waiters = idleWaiters
    idleWaiters = []
    waiters.forEach((resolve) => resolve())
  }

  /** Resolves once nothing is queued or in flight — i.e. every chunk
   *  handleWritten has seen so far has actually reached the server. */
  function whenIdle() {
    if (queue.length === 0 && !sending) return Promise.resolve()
    return new Promise((resolve) => idleWaiters.push(resolve))
  }

  function reportProgress(error) {
    onProgress?.(getStatus(error))
  }

  /**
   * Send queued chunks strictly one at a time, in order — mirroring
   * capture-writer's own oldest-first queue discipline — so the server's
   * append-only offset check can never see them out of order.
   */
  async function pump() {
    if (sending || failed || !accepted) return
    sending = true
    try {
      while (queue.length > 0 && !failed) {
        const chunk = queue[0]
        const offset = ackedBytes
        const tokenParam = token ? `&token=${encodeURIComponent(token)}` : ''
        const { res, error } = await sendWithRetry(() =>
          fetchImpl(
            `/rec/${encodeURIComponent(slug)}/server-copy/chunks?clientId=${encodeURIComponent(clientId)}&offset=${offset}${tokenParam}`,
            { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: chunk }
          )
        )
        if (error) {
          fail(error)
          break
        }
        if (!res.ok) {
          // A 409 here is the server's strict expectedOffset check
          // refusing this chunk — but that doesn't necessarily mean the
          // chunk itself never landed. If an earlier attempt's
          // *response* was what got lost (a network blip right after
          // the server had already durably appended the bytes),
          // sendWithRetry's retry re-sent this same offset, and the
          // server correctly refused it as stale, reporting back the
          // offset it actually has. Reconcile against that real offset
          // before giving up: if it already covers this chunk, the
          // chunk is done, not failed — advance past it exactly as a
          // normal ack would, rather than treating "already done" as an
          // error. Anything else (the server is genuinely behind what
          // this offset assumed) is a real, unexplained divergence no
          // retry can fix, so it still fails permanently.
          if (res.status === 409) {
            const data = await res.json().catch(() => ({}))
            const serverOffset = typeof data.bytesWritten === 'number' ? data.bytesWritten : -1
            if (serverOffset >= offset + chunk.byteLength) {
              ackedBytes = serverOffset
              queue.shift()
              reportProgress()
              continue
            }
          }
          fail(new Error(`server-copy chunk upload failed with status ${res.status}`))
          break
        }
        const data = await res.json().catch(() => ({}))
        ackedBytes = typeof data.bytesWritten === 'number' ? data.bytesWritten : offset + chunk.byteLength
        queue.shift()
        reportProgress()
      }
    } finally {
      sending = false
      notifyIdleWaiters()
    }
  }

  /**
   * Wired up as capture-writer's `onWritten`. Fire-and-forget by contract
   * (capture-writer never awaits it), so this never throws and never
   * returns a promise the writer would wait on.
   */
  function handleWritten(i16) {
    if (failed) return // this session is done; never queue after giving up
    // Copy defensively: the caller may reuse/recycle the underlying buffer
    // once this synchronous call returns, and queued chunks can sit for a
    // while before pump() actually sends them.
    const bytes = i16.buffer.slice(i16.byteOffset, i16.byteOffset + i16.byteLength)
    confirmedBytes += bytes.byteLength
    queue.push(bytes)
    reportProgress()
    pump()
  }

  /**
   * Requests session acceptance from the server for the active room.
   * Resolves `true` only once accepted — until then (and if it's ever
   * rejected, e.g. an expired/deleted room) no chunk bytes are sent, even
   * if handleWritten has already queued some.
   */
  async function start() {
    const { res, error } = await sendWithRetry(() =>
      fetchImpl(`/rec/${encodeURIComponent(slug)}/server-copy/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId, token })
      })
    )
    if (error) {
      fail(error)
      return false
    }
    if (!res.ok) {
      fail(new Error(`server-copy session was not accepted (status ${res.status})`))
      return false
    }
    const data = await res.json().catch(() => ({}))
    if (!data.accepted) {
      fail(new Error('server-copy session was not accepted'))
      return false
    }
    accepted = true
    ackedBytes = typeof data.bytesWritten === 'number' ? data.bytesWritten : 0
    pump() // drain anything that arrived via handleWritten while start() was in flight
    return true
  }

  /**
   * The explicit finalize signal — see the module-level doc comment.
   * Never sends the finalize request while chunks are still queued or in
   * flight, never after this session has already failed or was never
   * accepted, and is safe to call more than once (a second call after a
   * successful finalize is a no-op success).
   */
  async function finish() {
    if (finalized) return true
    await whenIdle()
    if (failed || !accepted) return false

    const { res, error } = await sendWithRetry(() =>
      fetchImpl(`/rec/${encodeURIComponent(slug)}/server-copy/finalize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId, totalBytes: confirmedBytes, sampleRate, token })
      })
    )
    if (error) {
      fail(error)
      return false
    }
    if (!res.ok) {
      fail(new Error(`server-copy finalize was not accepted (status ${res.status})`))
      return false
    }
    const data = await res.json().catch(() => ({}))
    finalized = !!data.finalized
    reportProgress()
    return finalized
  }

  function getStatus(error) {
    return {
      accepted,
      failed,
      finalized,
      ackedBytes,
      confirmedBytes,
      progress: confirmedBytes === 0 ? 0 : Math.min(1, ackedBytes / confirmedBytes),
      error: error ?? null
    }
  }

  return { start, handleWritten, finish, getStatus }
}
