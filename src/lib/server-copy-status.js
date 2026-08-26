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
