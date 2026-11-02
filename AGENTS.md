# Agent notes — podcast-recorder

Kept deliberately short. If the code explains itself, it isn't repeated here — this
is for what a fresh session won't discover just by reading files: hard-won lessons
and traps already hit once.

## The one rule everything else serves

**Never lose or corrupt someone's recording, and never let the UI claim things are
fine when they might not be.** Every fix in this codebase's history that mattered
was really this rule getting violated somewhere. When touching the recording or
sync path, ask: does this risk silently losing audio, or silently showing a status
that isn't true?

## Recording, locally

Each browser captures its own audio. The **Local Copy** is written into this
browser's private storage (OPFS, `local-copy/<room>/…-take-N.wav`) by
`local-copy-worker.js` through a sync access handle, so every chunk lands in
place and a crash keeps the audio. Don't swap that for `createWritable()`:
it only publishes on close, so a crash loses the whole take. Works in Chrome,
Firefox and Safari; there is no folder picker and no user gesture at start.
`startRecording()` calls `localCopy.openNext()` for a new take. A rejected
check finalizes that file and rolls to the next one — never delete, truncate,
or reopen an earlier attempt, including one left by an earlier visit.
Save is a real `<a download>` link to a Blob of a fresh header plus
`file.slice()` (Safari drops the click's user activation across awaits, and a
take that ended early is repaired from its size without rewriting it). Save
never deletes: the page can't see whether the download landed, so a take
leaves this browser only through a confirmed Remove. Kept takes are listed
again on later visits.

Safari (and DuckDuckGo on Mac) leave `AudioContext.resume()` pending until
a click on the page. Never `await` it outside a click: doing so in audio
init blocked `connectWs()`, so the room showed "Waiting for guest" with no
tabs. Any click wakes audio; until then the room shows the mic is paused.
Playwright's browsers lift this rule, so `audio_needs_click.spec.js`
reproduces it.

`recording-session.js` feeds the same ordered chunks independently to the local
WAV writer and server upload. A permanent save failure stops capture and lets
the surviving destination finish. A failed local chunk is never confirmed or
skipped so later chunks can be saved. The browser file stream cannot be
repaired by retrying writes on an errored stream. A retake calls
`stop({ capture: false })` so the worklet keeps running while the next file
opens. The room-level start/stop protocol lives in `synced-recording-session.js`,
not in that take coordinator.

The worklet advances samples on every audio callback, using zeros when input is
missing. Silence belongs in those captured chunks; disk latency must never create
extra samples. The old latency-based gap calculation corrupted a real 50-minute
episode (commit: `fix(recording): stop write latency from being recorded as silence`).
Stop flushes the partial chunk and acknowledges completion before destinations
finalize. Each take starts with an empty worklet buffer.

Waveforms and host play of a guest's mic-check clip use confirmed local writes
(`onWritten`). The live level meter intentionally remains live for gain adjustment.
The table Play control is the confirmed listen-back buffer relayed over the room
WebSocket, not a live talk path. The **stay-quiet** indicator during a Check Turn
is sequence state (`createCheckTurnSequence`), never live mic level. Server upload
receives captured chunks directly; putting it behind `onWritten` would make a
stalled disk stall both copies.

Recording issues go through `onIssue({ code, severity, destination, message, error })`.
For now the page logs them to the inspector console; no recording alerts or new
warning UI. Only permanent save failures automatically stop recording. The callback
is the future UI integration point. Simultaneous destination failure can lose audio;
there is deliberately no browser-storage recovery layer in this design.

Guest-facing leave/exit copy is reassurance-first (`deriveExitGuard` in
`src/lib/recording/exit-guard.js`): the automatic server copy is what the
host uses, so idle/complete leave copy must not read as "send the local
file yourself." That send-it-another-way wording is only for an
incomplete convenience upload (`uploading` / `catching_up`). Permanent
failure is a different alert — never rewrite it as reassurance, and never
claim a failed copy is backed up.
## Keeping host and guest in sync

One WebSocket connection per browser, owned by `src/lib/room/room-connection.js`.
Reconnects use backoff + jitter and are otherwise invisible to callers.

The one thing to know: any state that's true locally but not yet known to the
server (recording, talking, anything like them added later) must re-announce itself on every successful
connect — register it with `room.registerResync(fn)`. Skipping this is exactly
how the "Recording" pill went stuck-wrong after any reconnect and stayed that
way for a whole session, undetected — Talk had its own one-off fix, Recording
didn't, and nobody noticed until a real episode broke. Don't hand-build a fix
for a new flag; register it on the existing mechanism. Room recording control
also registers there, but `recording_session_sync` reads the authoritative
room phase. Its local phase seeds only an uninitialized room; replaying an
old host phase into a known room would overwrite a guest's valid change
while the host was away. Explicit offline control changes are re-announced
when that peer still holds control.

Check policy lives in `check-turn-coordinator.js`; the page supplies facts,
confirmed writes with their attempt identity, and file/marker adapters. Register
its `resync()` with the room. The existing room recording state owns the check's
`sessionId`, `roundId`, and `revision`; actions use those identities as a compare
and swap. Keep metadata on presence, previews, and marker events. Reconnects
retain rounds; a new participant pairing or rejection starts a new one. A late
retake result must pass both lifecycle and abort guards before publishing.
The attempt adapter seals and retains files and returns an outcome; it never
starts a check. Stop closes check UI before awaiting a roll or file finalization.

Skip/Close/Escape on one's own check advances only that participant and returns
them to the room. Waiting and retaking have Back to room/Escape without passing
anyone. Dismissal survives replay, turn changes, and retake completion; Show check
explicitly reopens current pending work. Room decision/save dialogs yield check
presentation without passing it or automatically bringing it back afterward.

The take boundary is the scheduled **Take Marker** instant (`triggerAtMs`
corrected by clock offset), not WebSocket receipt. Never truncate or
rewrite confirmed writes to "start the take" — store a `startSample`
offset and leave the file intact. Don't claim the take is ready before
that instant.

A synced stop closes the host's file on the tail Take Marker instant
(`edge: 'end'`, 2000ms server lead), or on the 2500ms fallback if that
echo never comes back. It does not wait on the guest. Once closed, a late
echo must not stop again or clear "the other side may still be
recording."

## Room age does not delete

There is no expiry helper and no cleanup timer. A room stays listed with
its original `created_at` until an explicit dashboard delete. Visiting
`/rec/{slug}` and occupancy must not call `deleteRoom` or redirect
`/?expired=1` because of age. Do not reintroduce delete-on-age.

`guest_lock_at` is a separate clock (same value as `created_at` on insert;
a null or non-finite value is read as `created_at` by `guestLockAt`).
Unlock is the only writer, and it never moves `created_at`.

Guest refusal is only `guestJoinDecision` in `guest-join.js`. The room
page and the WebSocket both call it. After a guest is actually in
(authenticated page load or successful WebSocket join), call
`noteAdmittedGuest`. A refused join, a wrong password, and a host must
not stamp last access — that stamp clears an inactivity lock. The
dashboard row uses `anyGuestLocked`: true when any guest decision is a
refusal, not a hard-coded list of reasons. Server-copy length is
`serverCopySeconds`. Hosts are never locked.

## Running things here

- `npm run check:standalone` — confirms `ws-rooms.js` loads under plain Node
 with no Vite/SvelteKit involved (`server.js`/`server-ws-dev.js` both load it
 that way). Runs automatically before `npm test`. `npx vitest run` alone
 won't catch a module in that import graph reaching for a SvelteKit-only
 virtual import (`$env/*`, `$app/*`) — vitest itself runs through Vite, so
 those always resolve there regardless of whether real startup would crash.
 If you add a new import to anything `ws-rooms.js` pulls in, run this.
 Vite HMR does **not** reload `server-ws-dev.js`: after changing
 `ws-rooms.js` (or anything it imports), restart `npm run dev` or the
 request/session handlers you just added will never run.
- `npx vitest run` — unit tests, fast, no server needed.
- `npm run test:coverage` — same unit tests plus a `coverage/` HTML report.
- `npx svelte-check` — run `npx svelte-kit sync` first if `.svelte-kit/` is missing.
- `npm run build` — production build check.
- Playwright e2e needs a local `.env` with `SECRET` set (gitignored, not
  committed) — `npm run dev` fails outright with `.env: not found` otherwise.
- A sandboxed container may have a Chromium revision that doesn't match the
  pinned `@playwright/test` version. If `browserType.launch` complains about a
  missing revision, add `executablePath: '/opt/pw-browsers/chromium'` to
  `playwright.config.js`'s `launchOptions` for that run — don't commit it.
