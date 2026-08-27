# 09: Retry server-copy requests with backoff

**What to build:** A transient network failure during server-copy upload (a dropped
connection, a timeout, a 5xx) is retried with backoff before the session gives up,
instead of failing permanently on the very first error. Session-accept, chunk
upload, and finalize all get the same treatment. This is retry within one live
upload session only — it is not resumable upload across a page reload or room
rejoin (see `z_08-handle-interrupted-or-failed-server-copy-as-manual-transfer.md`,
which still governs that case: a session that gives up, or is torn down and
re-created by leaving/rejoining, stays permanently incomplete and the local WAV
remains the fallback).

**Blocked by:** None (can start immediately; the whole series 02–08 is done).

**Status:** done

**Architectural context:** `src/lib/server-copy-upload.js` currently treats any
`fetch` rejection or non-OK response from `/server-copy/session`,
`/server-copy/chunks`, or `/server-copy/finalize` as terminal: `fail()` sets
`failed = true` permanently, clears the queue, and `handleWritten` becomes a
no-op forever after. That is too eager for ordinary transient blips (a few
seconds of bad wifi) — those should not cost a whole recording's server copy.

Two things to get right, not just "wrap fetch in a retry loop":

1. **Retries must be bounded**, in both attempt count and total elapsed time, so
   a session that's actually dead (not transient) still reaches the existing
   permanent-`failed` state in reasonable time rather than retrying forever —
   the local-recording-is-unaffected guarantee this module was built around
   must hold throughout: retries happen off to the side, never delaying or
   blocking `handleWritten`'s caller (`capture-writer.js`'s fire-and-forget
   `onWritten`).
2. **Retries must be safe against a lost acknowledgement, not just a lost
   request.** The server's chunk-append check (`server-copy-session.js` /
   `server-copy-storage.js`) is a strict `expectedOffset` check keyed off bytes
   already durably on disk. If a chunk POST's *response* is what got lost (the
   server actually wrote the bytes, but the client never saw the 200), a naive
   "retry the same request" will get back a 409 offset-mismatch and must not
   treat that as a fresh failure — it needs to reconcile with the server's
   real current offset (already returned by the session/chunks endpoints) and
   either treat "the bytes I was retrying are already accounted for" as
   success, or resubmit correctly from the true offset. Read
   `tests/unit/server-copy-routes.test.js` and `server-copy-storage.js`
   closely to understand the exact offset semantics before writing retry logic
   against them.

Distinguish retryable from non-retryable failures: a network error, timeout, or
5xx is retryable. A room being expired/deleted, a session being explicitly
rejected, or any other 4xx that reflects real, permanent state should still
fail immediately — don't retry a fundamentally-not-going-to-succeed request.

- [x] Chunk upload retries a transient failure (network error/timeout/5xx) with
      backoff instead of failing the whole session on first error.
- [x] Session-accept and finalize get the same transient-retry treatment.
- [x] Retries are bounded (max attempts and/or max elapsed time); exceeding the
      bound still reaches the existing permanent `failed` state from ticket 08.
- [x] A retry after a lost acknowledgement (server already durably has the
      bytes, client didn't see the response) is reconciled correctly and does
      not spuriously fail the session.
- [x] A non-retryable failure (expired/deleted room, explicit rejection) still
      fails immediately without wasting retry attempts.
- [x] Retries never delay, block, or affect local recording — `handleWritten`
      remains fire-and-forget exactly as before.
- [x] Tests cover: transient-then-success (retry recovers), retries exhausted
      (still reaches permanent `failed`), lost-ack reconciliation, and a
      non-retryable failure short-circuiting retries.
