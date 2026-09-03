/**
 * Pure decision logic for the room page's "don't lose work on the way out"
 * exit guard (ticket 01, extended by ticket 07).
 *
 * Two independent things can make leaving the room risky, and they are
 * deliberately not treated as equally severe:
 *
 *   - an ACTIVE LOCAL RECORDING — the WAV is still being written to disk.
 *     Leaving risks that write never finishing. This is the primary
 *     artifact (see AGENTS.md's "one rule everything else serves") and the
 *     warning must say so plainly.
 *   - an INCOMPLETE SERVER COPY *after* the local recording has already
 *     stopped — the WAV is already safe on disk; only the convenience
 *     mirror to the server hasn't finished uploading/finalizing yet.
 *     Leaving costs a manual re-send later, never the recording itself,
 *     and the warning must not read as if it does.
 *
 * Every route into leaving the page (native beforeunload, in-app link
 * clicks, SvelteKit navigation) asks this single function which situation
 * currently applies, so the two warnings can never disagree or double-fire
 * — at most one ever applies at a time, and active-recording always wins
 * when both are true, because it is strictly the worse of the two.
 */

/** @typedef {'recording' | 'upload' | null} ExitGuardSeverity */

const RECORDING_MESSAGE =
  'Your local recording is still in progress. Leaving now could stop it before the WAV is finalized. Leave anyway?'

const UPLOAD_MESSAGE =
  "Your recording is already saved on this device. The server copy hasn't finished uploading yet — " +
  "if you leave now, you'll need to send the local file to the host another way. Leave anyway?"

export function deriveExitGuard({ hasActiveLocalRecording, hasIncompleteServerCopyUpload }) {
  if (hasActiveLocalRecording) {
    return { blocking: true, severity: 'recording', message: RECORDING_MESSAGE }
  }
  if (hasIncompleteServerCopyUpload) {
    return { blocking: true, severity: 'upload', message: UPLOAD_MESSAGE }
  }
  return { blocking: false, severity: null, message: '' }
}

const INCOMPLETE_UPLOAD_STATES = new Set(['uploading', 'catching_up'])

/**
 * True for any $lib/server-copy/server-copy-status.js ServerCopyUploadState that means
 * "the server copy has not reached ticket 05's definition of complete yet,
 * and still might" — i.e. accepted but not yet finalized. Shared by the
 * exit guard above and the post-stop blocking modal (ticket 07) so both
 * agree on exactly the same set of states without re-deriving it twice.
 *
 * Deliberately excludes `failed` (ticket 08): once a copy has permanently
 * failed there is nothing left to wait for or warn about losing — leaving
 * costs nothing further than it already has, so it must not block exit the
 * way a still-possibly-finishing upload does. The one-time failure notice
 * ($lib/server-copy/server-copy-status.js's shouldAnnounceServerCopyFailure) is what
 * tells the user about that instead.
 */
export function isIncompleteServerCopyUpload(uploadState) {
  return INCOMPLETE_UPLOAD_STATES.has(uploadState)
}
