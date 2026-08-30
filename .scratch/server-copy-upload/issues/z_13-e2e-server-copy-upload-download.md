# 13: End-to-end Playwright coverage for server-copy upload and download

**What to build:** A real, browser-driven Playwright suite (`tests/playwright/`)
that exercises the whole server-copy-upload feature the way an actual host
and guest would — not just unit-level mocks. Record for real (the repo's
existing Chromium fake-media-device flags make this a genuine, if synthetic,
audio capture), watch the sidebar's server-copy percentage move and complete,
stop and watch the post-stop wait modal behave, and — new, added by ticket 12
— actually click the host's download button and confirm a real file comes
back. Also cover the interrupted/failed path from the guest's perspective.

**Blocked by:** 11 (bind server-copy clientId to owner) and 12 (host download
button) — both change wiring this suite depends on (the token the client
needs to upload at all, and the control this suite needs to click). Check for
`z_11-...` and `z_12-...` in this directory before starting.

**Status:** done

**Architectural context:** Read `tests/playwright/recording_status.spec.js`
and `tests/playwright/helpers.js` first — they are the direct precedent for
this ticket: two-browser host/guest setup via `browser.newPage()` +
`createRoom`/`joinAsGuest`, real Start/Stop Recording clicks, polling
`expect(...).toBeVisible()` on `.pill-recording` rather than fixed sleeps, and
`trackLiveSockets`/`closeLiveSockets` for simulating a dropped connection.
Follow those exact conventions — same helper functions, same polling style,
same generous-timeout philosophy for a `npm run dev` server that's still
warming up. Do not invent a parallel testing approach.

The sidebar's server-copy pill (`src/lib/RoomDetailsPanel.svelte`) exposes
`.pill-copy-unavailable` / `.pill-copy-progress` / `.pill-copy-complete` /
`.pill-copy-failed` classes and a `{percent}%` text suffix while in progress
— assert on these the same way `recording_status.spec.js` asserts on
`.pill-recording`. `src/lib/ServerCopyWaitModal.svelte` is the post-stop
blocking-progress modal (ticket 07); `src/lib/exit-guard.js`'s two warning
severities are already covered for the *active-recording* case in
`recording_status.spec.js`'s last test (`'active local recording warns
before in-app navigation'`) — mirror that pattern for the *incomplete-upload*
severity instead, checking the dialog message is the softer one (mentions
sending the file another way, doesn't use the active-recording warning's
stronger language).

For the interrupted-upload scenario, use Playwright's request interception
(`page.route('**/server-copy/chunks*', route => route.abort())` or similar,
installed on the guest's page before/during recording) to simulate a network
failure specifically for server-copy chunk uploads without actually breaking
the room's WebSocket or the local recording — confirm the local WAV path is
completely unaffected (Stop Recording still works, no active-recording-style
warning fires afterward) while the sidebar pill on both browsers settles into
`pill-copy-failed`.

Recording needs to run long enough for multiple chunks to actually flow
before you assert on partial progress — a few seconds of real (fake-device)
audio capture, matching how long other tests in this suite wait for
WS-driven state to settle. Don't assert on an exact percentage number; assert
on the state transitions (unavailable/idle → in_progress with a percent that
increases or reaches high values → complete) the way the unit tests already
do in `server-copy-status.test.js`, just observed through the real UI instead
of a pure function.

- [x] A full happy-path spec: host and guest both record, sidebar percent
      pill progresses and both browsers see matching status (ticket 06's
      "both peers see the same state" claim, verified for real), copy
      reaches `complete` on both browsers after stopping.
- [x] The post-stop wait modal (ticket 07) appears when a copy is still
      incomplete right after stopping, shows a percentage, and auto-closes
      once the copy completes — observed with a real (if brief) window where
      upload hasn't caught up to a just-stopped recording.
- [x] The incomplete-upload exit warning is distinct from the active-recording
      warning (softer message, mentions sending the file another way) —
      mirroring `recording_status.spec.js`'s existing active-recording
      warning test but for this severity.
- [x] The host can click a real download control (ticket 12) once a
      participant's copy is `complete` and receives an actual file download
      — verify via Playwright's download event (`page.waitForEvent('download')`
      or equivalent) that a file arrives, is non-trivially sized, and is a
      WAV (check the response/suggested filename and, if easy, the RIFF/WAVE
      header bytes of the downloaded file).
- [x] A guest does not see/can't use the download control (ticket 12's
      host-only requirement, verified end-to-end).
- [x] An interrupted-upload spec: chunk requests are blocked mid-recording,
      the sidebar settles into the `failed` state on both browsers, the local
      recording and its exit-guard behavior are completely unaffected, and no
      download control appears for that participant.
- [x] All new specs pass reliably under `npm run test:e2e` (run it more than
      once locally if timing looks borderline — this suite's own comments
      note real flake sources around cold `npm run dev` starts; don't paper
      over a genuine race with a longer sleep instead of the right wait
      condition).
