# 06: Confirmed, synced stop with tail marker

**Read first:** this folder's README; ticket 02 (synced session core) and
ticket 04 (the clap/countdown mechanism this reuses at the tail end).

**What to build:** Stopping ends the take for both peers permanently, so
it needs to be a deliberate action, not a stray click. Whoever triggers
Stop (in practice, the host — per the "host controls recording" decision,
guests aren't given this control) sees an "are you sure — this stops the
recording for both of you" confirmation. On confirm: fire the same
clap+countdown mechanism as ticket 04 (a tail marker, useful for
post-production alignment/trim), wait ~2 seconds, then actually stop
recording on both sides. The triggering side's own stop must complete
regardless of whether the other peer acknowledges — a disconnected or
slow guest browser must not hang the host's own recording from closing
cleanly; surface that the guest's side may not have closed cleanly rather
than blocking on it.

**Where to look:** `RecordControls.svelte`'s Stop button
(`onToggleRecording` when `recordingState === 'recording'`) is the
trigger point for the confirmation dialog. Ticket 02's session-message
plumbing is what actually propagates the stop to the guest. Ticket 04's
clap-scheduling function is what this ticket calls again for the tail
marker — do not write a second tone-scheduling implementation.
`stopRecording()` in `+page.svelte` (referenced from
`rejectRecordingCheck()`, ~line 628) is the existing local stop path this
should still ultimately call on each side once the 2s count elapses.

**Out of scope:** the offline solo-Stop path (each peer's own Stop
working without any of this when the room isn't connected) is already
covered by ticket 02's fallback requirement — this ticket's confirmation
dialog and tail marker are the *synced* enhancement layered on top, and
must not be required for a solo local stop to work.

**TDD seams:**

1. Unit: Stop click opens a confirmation; canceling it leaves recording
   running unchanged on both sides (no partial stop, no tone fired).
2. Unit: confirming triggers the tail marker via the same function
   ticket 04 introduced, then stops both sides ~2s later.
3. Unit: the host's own local stop completes on schedule even when a
   simulated guest peer never acknowledges the stop message — assert no
   indefinite wait/hang, and that some observable "guest may not have
   stopped cleanly" state is set rather than silently assumed fine
   (AGENTS.md: never let the UI claim things are fine when they might not
   be).
4. E2E: two-peer room, mid-take; host clicks Stop, confirms; both sides'
   recordings stop ~2s after the confirm, with a shared tail-tone
   audible/detectable in both files' final seconds.
5. E2E: same, but guest's page is closed/unresponsive before the confirm
   — host's own recording still stops cleanly and the host sees the
   guest's-side-uncertain indicator.

**Blocked by:** 02 — Synced recording session core, 04 — Take marker
mechanism (reused here for the tail).

**Status:** ready-for-agent

- [ ] Stop shows an "are you sure, stops for both" confirmation before
      anything happens.
- [ ] Canceling leaves both sides recording, untouched.
- [ ] Confirming fires the shared clap/countdown mechanism, then stops
      both sides ~2s later.
- [ ] Host's own stop is never blocked by a non-responsive/disconnected
      guest; that condition is surfaced, not silently ignored or hung on.
- [ ] Reuses ticket 04's marker-scheduling function; no duplicate tone-
      scheduling implementation.
- [ ] TDD on the seams above.
- [ ] Coverage: confirm/cancel × guest responsive/unresponsive.
- [ ] E2E: normal two-peer stop with tail marker; stop with an
      unresponsive guest.
- [ ] Docs: `CONTEXT.md` update to the **Take Marker** entry noting it's
      used at both ends of a take; `AGENTS.md` note that a synced stop
      must never hang the host's own recording on the guest's ack.
