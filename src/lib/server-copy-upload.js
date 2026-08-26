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
 * Once a chunk upload fails (network error, non-OK response, or an
 * offset-mismatch from the server), this session gives up permanently —
 * per design, there is no resumable upload (see ticket 08): the server
 * copy is simply left incomplete, and the local WAV remains the fallback.
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
export function createServerCopyUpload({ slug, clientId, sampleRate, fetchImpl = fetch, onProgress } = {}) {
  if (!slug) throw new Error('createServerCopyUpload: slug is required')
  if (!clientId) throw new Error('createServerCopyUpload: clientId is required')

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
        let res
        try {
          res = await fetchImpl(
            `/rec/${encodeURIComponent(slug)}/server-copy/chunks?clientId=${encodeURIComponent(clientId)}&offset=${offset}`,
            { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: chunk }
          )
        } catch (e) {
          fail(e)
          break
        }
        if (!res.ok) {
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
    let res
    try {
      res = await fetchImpl(`/rec/${encodeURIComponent(slug)}/server-copy/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId })
      })
    } catch (e) {
      fail(e)
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

    let res
    try {
      res = await fetchImpl(`/rec/${encodeURIComponent(slug)}/server-copy/finalize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId, totalBytes: confirmedBytes, sampleRate })
      })
    } catch (e) {
      fail(e)
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
