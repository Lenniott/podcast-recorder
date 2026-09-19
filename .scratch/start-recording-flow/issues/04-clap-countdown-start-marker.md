# 04: Clap + countdown as the synced "take starts now" marker

**Read first:** this folder's README; ticket 03 (the both-turns-passed
signal this consumes). Glossary to add: **Take Marker** (the synced
clap+countdown moment that flips a session from "checking" to "the real
take," used at both start here and stop in ticket 06).

**What to build:** Once ticket 03's sequence signals both host and guest
passed their check, fire a clap tone and a short countdown, synced across
both browsers to the same physical instant, and only from that instant on
does recorded audio count as the take (earlier check-sequence audio is
not part of it). This reuses the *mechanism* of the existing manual Clap
("Sync Tone Marker" in `RecordControls.svelte`) — same tone injection,
same clock-offset-corrected scheduling — triggered automatically instead
of by a manual button press, at this one specific moment.

**Where to look:** `src/lib/recording/clock-sync.js` — `createClockSync`,
`offset`, and the `triggerAtMs` pattern. `src/routes/rec/[slug]/+page.svelte`
— `sendClap()` (~line 774), `injectClap(from, triggerAtMs)` (~line 783),
and the `clap` WS message handling (~line 845-852, including the
`pendingClaps` queue for when `audioEngineReady` isn't true yet) is the
exact mechanism to reuse: send a server timestamp, every peer schedules
`audioEngine.scheduleClapTone(delayMs)` using their own clock offset so
it lands simultaneously. `audio-engine.js`'s `scheduleClapTone` is the
tone-injection primitive itself — do not reimplement tone generation.

**Out of scope:** what makes "both turns passed" true is ticket 03's job,
not this ticket's. What happens on Stop (the mirrored clap+2s-count) is
ticket 06, which should call the *same* underlying scheduling function
this ticket introduces/extends — don't fork a second implementation.

**TDD seams:**

1. Unit: on the both-turns-passed signal, a server-timestamped trigger is
   sent once (not per-peer, not duplicated on a flaky signal) and
   scheduled locally via the existing offset-correction math, matching
   the existing manual-clap test coverage's shape.
2. Unit: "is this a real take yet" flips to true exactly at the
   scheduled instant, not when the trigger message is merely received
   (mirrors the existing `pendingClaps` queue behaviour for a not-yet-
   ready audio engine).
3. Unit: content written to `capture-writer.js` before the marker is
   excluded from what's presented as "the take" (however that boundary
   is surfaced — e.g. a marker offset stored alongside the file/session,
   not a second file) — do not solve this by truncating/deleting bytes
   already committed to disk (README/AGENTS.md: never destructively
   rewrite a confirmed write).
4. E2E: two-peer room through ticket 03's full sequence; assert the clap
   tone and take-start boundary land at the same physical moment on both
   sides (existing clap-sync e2e test, if one exists for the manual
   button, is the pattern to extend).

**Blocked by:** 03 — Turn-taking mic check on synced start.

**Status:** ready-for-agent

- [ ] Clap + countdown fires automatically and synced, once, when ticket
      03 signals both turns passed — no manual button press required for
      this specific moment (the existing manual Clap button is untouched
      for its other, general-purpose use).
- [ ] The tone lands at the same physical instant on host and guest,
      using the existing clock-offset/`triggerAtMs` mechanism, not a new
      timing approach.
- [ ] Audio written before the marker is never presented as part of "the
      take," without deleting or rewriting anything already on disk.
- [ ] Handles the not-yet-ready-audio-engine case the same way the
      existing `pendingClaps` queue does for the manual clap.
- [ ] TDD on the seams above.
- [ ] Coverage: engine-ready / not-yet-ready × trigger-received-once.
- [ ] E2E: full sequence from ticket 03 through the synced marker.
- [ ] Docs: `CONTEXT.md` **Take Marker** entry, explicitly noting it is
      the same mechanism the manual Clap and Watch Together already use.
