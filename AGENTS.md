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
touches the server. The write path (`src/lib/capture-writer.js`) has one hard
invariant: **silence is only ever written from an explicit, measured gap**
(`notifyDeviceGap`), never inferred from how long a disk write took. That
inference is exactly the bug that corrupted a real 50-minute episode — search the
commit history for `fix(recording): stop write latency from being recorded as
silence` for the full diagnosis if you need it. Don't reintroduce an
"expected-vs-actual timing" comparison as a stand-in for "did the mic drop out."

Anything that shows recording health to the user (waveform, level meter, status
pill) must be sourced from what was actually confirmed written
(`capture-writer.js`'s `onWritten` hook), never from the live mic signal. The mic
can look perfectly healthy while the file quietly diverges from it — that gap is
what let the original bug go unnoticed for an hour.

## Keeping host and guest in sync

One WebSocket connection per browser, owned by `src/lib/room-connection.js`.
Reconnects use backoff + jitter and are otherwise invisible to callers.

The one thing to know: any state that's true locally but not yet known to the
server (recording, talking, anything like them added later) must re-announce
itself on every successful connect — register it with `room.registerResync(fn)`.
Skipping this is exactly how the "Recording" pill went stuck-wrong after any
reconnect and stayed that way for a whole session, undetected — Talk had its own
one-off fix, Recording didn't, and nobody noticed until a real episode broke.
Don't hand-build a fix for a new flag; register it on the existing mechanism.

## Running things here

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
