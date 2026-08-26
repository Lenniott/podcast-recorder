/**
 * Pure mapping from a server-copy upload's internal status (see
 * $lib/server-copy-upload.js's getStatus()) to the small, display-ready
 * shape that gets broadcast over the room WebSocket and rendered in the
 * sidebar.
 *
 * Kept separate from both the upload module (which doesn't know or care
 * how its progress is displayed) and the page/component (which shouldn't
 * have to re-derive this logic) so the four visual states — and the "100%
 * mid-recording is normal" rule — are defined and tested in one place.
 *
 * Deliberately produces only a rounded percentage, never a byte count:
 * this is the value that goes out over the wire to the other peer, and it
 * must never imply the raw chunk/byte data behind it.
 */

/** @typedef {'unavailable' | 'in_progress' | 'complete' | 'failed'} ServerCopyDisplayState */

export function deriveServerCopyDisplay(status) {
  if (!status || !status.accepted) {
    // No session yet, still waiting on acceptance, or the session was
    // rejected outright (expired/deleted room) without ever queuing bytes —
    // all read as "no server copy", not a failure the user needs to act on,
    // unless it did fail (a rejected session still sets `failed`).
    return { state: status?.failed ? 'failed' : 'unavailable', percent: 0 }
  }
  if (status.failed) {
    return { state: 'failed', percent: toPercent(status.progress) }
  }
  if (status.finalized) {
    return { state: 'complete', percent: 100 }
  }
  // Accepted, not failed, not finalized yet — normal in-progress upload.
  // progress can legitimately already read 100 here (fast connection ahead
  // of a still-running local recording); that is not "complete" until
  // finish() has confirmed the final length with the server.
  return { state: 'in_progress', percent: toPercent(status.progress) }
}

function toPercent(progress) {
  const p = Number.isFinite(progress) ? progress : 0
  return Math.max(0, Math.min(100, Math.round(p * 100)))
}

/** @typedef {'idle' | 'uploading' | 'catching_up' | 'complete' | 'failed'} ServerCopyUploadState */

/**
 * A finer-grained sibling of deriveServerCopyDisplay's four-state
 * vocabulary, distinguishing "still uploading while the local recording is
 * still running" from "local recording has stopped, server copy is still
 * catching up" — the page needs that distinction for accurate warning copy
 * and for the post-stop blocking modal (ticket 07), even though both read
 * as the single "in_progress" display state in the sidebar.
 *
 * `isRecording` is the only thing this needs from the page beyond the
 * upload's own status, since the status object alone can't say whether the
 * local writer is still running.
 */
export function deriveServerCopyUploadState(status, { isRecording = false } = {}) {
  if (!status || !status.accepted) return status?.failed ? 'failed' : 'idle'
  if (status.failed) return 'failed'
  if (status.finalized) return 'complete'
  return isRecording ? 'uploading' : 'catching_up'
}

/**
 * Ticket 08: whether to surface a one-time, explicit explanation that
 * *this* participant's own server copy has permanently failed.
 *
 * The post-stop wait modal (ticket 07, $lib/ServerCopyWaitModal.svelte)
 * only stays open for `isIncompleteServerCopyUpload` states
 * ($lib/exit-guard.js), which deliberately excludes `failed` — there's
 * nothing left to wait for, so it isn't blocking. But that also means the
 * modal simply closes the instant a copy fails, exactly as if it had
 * finished normally, with nothing beyond the sidebar pill to tell the user
 * what actually happened. This is the trigger for a page-level one-time
 * notice that fills that gap: fires once local recording has fully
 * stopped (never interrupts an active take) and only once per take,
 * governed by the caller's own `announced` flag — reset the same way the
 * rest of this take's server-copy state resets whenever a new recording
 * starts (see +page.svelte's startRecording()).
 */
export function shouldAnnounceServerCopyFailure({ recordingState, uploadState, announced = false } = {}) {
  return recordingState === 'idle' && uploadState === 'failed' && !announced
}
