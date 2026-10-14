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

Each browser captures and writes its own WAV file independently — audio never
touches the server. The **Local Copy** folder is chosen once at room
join (`showDirectoryPicker` from the explainer screen's own click, in
`readwrite` mode, `startIn: 'downloads'`, so a guest's remote-triggered
start needs no gesture). Chrome refuses the Downloads folder itself
("contains system files"); a folder inside it is allowed.
`startRecording()` must not call either picker: it calls
`localCopyPicker.openNext()` for a new `-take-N.wav` in that folder, then
`openRecordingFile`. A rejected check finalizes that file (header patched,
bytes left) and rolls to the next one — never delete, truncate, or reopen
an earlier attempt, including one left in the folder by an earlier visit
(`createWritable()` truncates). The write path (`src/lib/recording/capture-writer.js`) has one hard
invariant: **silence is only ever written from an explicit, measured gap**
(`notifyDeviceGap`), never inferred from how long a disk write took. That
inference is exactly the bug that corrupted a real 50-minute episode — search the
commit history for `fix(recording): stop write latency from being recorded as
silence` for the full diagnosis if you need it. Don't reintroduce an
"expected-vs-actual timing" comparison as a stand-in for "did the mic drop out."

Anything that shows recording health to the user (waveform, level meter, status
pill, **host play of a guest's mic-check clip**) must be sourced from what was
actually confirmed written (`capture-writer.js`'s `onWritten` hook), never from
the live mic signal. The mic can look perfectly healthy while the file quietly
diverges from it — that gap is what let the original bug go unnoticed for an
hour. The table Play control is that same listen-back buffer, relayed over the
room WebSocket; it is not a live talk path. The **stay-quiet** indicator during
a Check Turn is sequence state (`createCheckTurnSequence`), never live mic
level.

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
server (recording, talking, the host's **Synced Recording Session** phase,
anything like them added later) must re-announce itself on every successful
connect — register it with `room.registerResync(fn)`. Skipping this is exactly
how the "Recording" pill went stuck-wrong after any reconnect and stayed that
way for a whole session, undetected — Talk had its own one-off fix, Recording
didn't, and nobody noticed until a real episode broke. Don't hand-build a fix
for a new flag; register it on the existing mechanism. The session phase is
the same class of bug: a host who reconnects mid-take must re-send
`recording_session` so the room's stored phase and the other peer match
local truth. A live Check Turn (`recording_check` with `turn`, plus `open`
if this peer's modal is up) is the same: re-announce it on `registerResync`
or the other peer's stay-quiet / modal pairing goes stale after a blip.

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

## Running things here

- `npm run check:standalone` — confirms `ws-rooms.js` loads under plain Node
  with no Vite/SvelteKit involved (`server.js`/`server-ws-dev.js` both load it
  that way). Runs automatically before `npm test`. `npx vitest run` alone
  won't catch a module in that import graph reaching for a SvelteKit-only
  virtual import (`$env/*`, `$app/*`) — vitest itself runs through Vite, so
  those always resolve there regardless of whether real startup would crash.
  If you add a new import to anything `ws-rooms.js` pulls in, run this.
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
