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
touches the server. The write path (`src/lib/recording/capture-writer.js`) has one hard
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
room WebSocket; it is not a live talk path.

## Keeping host and guest in sync

One WebSocket connection per browser, owned by `src/lib/room/room-connection.js`.
Reconnects use backoff + jitter and are otherwise invisible to callers.

The one thing to know: any state that's true locally but not yet known to the
server (recording, talking, anything like them added later) must re-announce
itself on every successful connect — register it with `room.registerResync(fn)`.
Skipping this is exactly how the "Recording" pill went stuck-wrong after any
reconnect and stayed that way for a whole session, undetected — Talk had its own
one-off fix, Recording didn't, and nobody noticed until a real episode broke.
Don't hand-build a fix for a new flag; register it on the existing mechanism.

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
  `npm run test:e2e` generates a throwaway one automatically now
  (`scripts/ensure-dev-env.sh`, dummy values only) if none exists.
- A sandboxed container may have a Chromium revision that doesn't match the
  pinned `@playwright/test` version. If `browserType.launch` complains about a
  missing revision, add `executablePath: '/opt/pw-browsers/chromium'` to
  `playwright.config.js`'s `launchOptions` for that run — don't commit it.
- `npm run test:e2e:friend` (`scripts/run-e2e-friend.sh`) runs the three
  specs `npm run test:e2e` always skips by design — `wrong_site_password`,
  `friend_login`, `friend_room_cap` — which only exercise anything against a
  server with `SITE_PASSWORD`/`FRIEND_PASSWORD` actually set (the shared e2e
  webServer deliberately blanks `SITE_PASSWORD` for every other spec's
  isolation/speed). It starts its own `npm run dev` with both set plus a
  few-second `FRIEND_ROOM_MAX_AGE_HOURS`, so the cap-expiry case doesn't need
  a real 12-hour wait, and tears it down after.
