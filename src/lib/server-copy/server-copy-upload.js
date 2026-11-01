/** Uploads captured PCM independently of the local file. Chunks are sent in
 * order, with bounded retries and offset reconciliation for lost responses.
 * finish() means capture has stopped, not that the local file has closed. */
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

export function createServerCopyUpload({ slug, clientId, takeId, sampleRate, fetchImpl = fetch, onProgress, onIssue, requestTimeoutMs = 5000, token: initialToken } = {}) {
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
  let capturedBytes = 0
  let finishing = false
  let finishPromise = null
  let failure = null
  let token = initialToken
  const queue = [] // ArrayBuffers awaiting upload, oldest-first
  let sending = false
  let startPromise = null
  let idleWaiters = [] // resolvers waiting for the queue to fully drain

  async function request(url, options) {
    const controller = new AbortController()
    let timer
    try {
      return await Promise.race([
        (async () => {
          const response = await fetchImpl(url, { ...options, signal: controller.signal })
          const data = await response.json().catch(() => ({}))
          return { ok: response.ok, status: response.status, json: async () => data }
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort()
            reject(new Error('Server audio request timed out'))
          }, requestTimeoutMs)
        })
      ])
    } finally { clearTimeout(timer) }
  }

  function fail(error) {
    if (failed) return
    failed = true
    failure = error
    queue.length = 0
    reportProgress(error)
    try { onIssue?.({ code: 'save-failed', severity: 'error', destination: 'server', message: 'Server audio save failed.', error }) } catch { /* reporting cannot break cleanup */ }
    notifyIdleWaiters()
  }

  function notifyIdleWaiters() {
    if (queue.length > 0 || sending) return
    const waiters = idleWaiters
    idleWaiters = []
    waiters.forEach((resolve) => resolve())
  }

  /** Resolves once nothing is queued or in flight — i.e. every chunk
   *  handleChunk has seen so far has actually reached the server. */
  function whenIdle() {
    if (queue.length === 0 && !sending) return Promise.resolve()
    return new Promise((resolve) => idleWaiters.push(resolve))
  }

  function reportProgress(error) {
    try { onProgress?.(getStatus(error)) } catch { /* reporting cannot interrupt uploads */ }
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
        const takeParam = takeId ? `&takeId=${encodeURIComponent(takeId)}` : ''
        const { res, error } = await sendWithRetry(() =>
          request(
            `/rec/${encodeURIComponent(slug)}/server-copy/chunks?clientId=${encodeURIComponent(clientId)}&offset=${offset}${tokenParam}${takeParam}`,
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

  function handleChunk(i16) {
    if (failed || finishing) return // this session is done; never queue after giving up
    // Copy defensively: the caller may reuse/recycle the underlying buffer
    // once this synchronous call returns, and queued chunks can sit for a
    // while before pump() actually sends them.
    const bytes = i16.buffer.slice(i16.byteOffset, i16.byteOffset + i16.byteLength)
    capturedBytes += bytes.byteLength
    queue.push(bytes)
    reportProgress()
    pump()
  }

  function setToken(nextToken) {
    token = nextToken
  }

  /**
   * Requests session acceptance from the server for the active room.
   * Resolves `true` only once accepted — until then (and if it's ever
   * rejected, e.g. an expired/deleted room) no chunk bytes are sent, even
   * if handleChunk has already queued some.
   */
  async function start() {
    if (failed) return false
    if (accepted) return true
    if (startPromise) return startPromise
    startPromise = startSession()
    return startPromise.finally(() => {
      startPromise = null
    })
  }

  async function startSession() {
    const { res, error } = await sendWithRetry(() =>
      request(`/rec/${encodeURIComponent(slug)}/server-copy/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId, token, takeId, sampleRate })
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
    pump() // drain anything that arrived via handleChunk while start() was in flight
    return true
  }

  /**
   * The explicit finalize signal — see the module-level doc comment.
   * Never sends the finalize request while chunks are still queued or in
   * flight, never after this session has already failed or was never
   * accepted, and is safe to call more than once (a second call after a
   * successful finalize is a no-op success).
   */
  function finish() {
    finishing = true
    if (!finishPromise) finishPromise = finalize()
    return finishPromise
  }

  async function finalize() {
    if (finalized) return true
    if (!accepted && !failed) await start()
    await whenIdle()
    if (failed || !accepted) return false

    const { res, error } = await sendWithRetry(() =>
      request(`/rec/${encodeURIComponent(slug)}/server-copy/finalize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId, takeId, totalBytes: capturedBytes, sampleRate, token })
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
    if (!finalized) fail(new Error('Server did not confirm finalization'))
    reportProgress()
    return finalized
  }

  function getStatus(error) {
    return {
      accepted,
      failed,
      finalized,
      ackedBytes,
      capturedBytes,
      confirmedBytes: capturedBytes, // compatibility for existing progress display
      takeId,
      progress: capturedBytes === 0 ? 0 : Math.min(1, ackedBytes / capturedBytes),
      error: error ?? failure
    }
  }

  return { start, handleChunk, finish, getStatus, setToken }
}
