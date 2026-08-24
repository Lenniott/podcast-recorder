# Room Connection — 3 tickets, run sequentially, fresh context each

Each ticket is self-contained: paste it whole into a fresh Claude Code
session on branch `claude/audio-silence-pattern-diagnosis-yfyx5u` (or
whatever branch ticket 1 lands on). Run `npx vitest run`, `npx svelte-check`,
`npm run build` yourself between tickets before starting the next one — each
ticket assumes the previous one's tests are green.

Context a fresh agent won't have and needs restated: this fixes a real
production bug. `recording` is a client-owned flag (true state lives in the
browser's local WAV-writing pipeline, not the server) that gets sent once
via `wsNotifyState('recording')` inside `startRecording()`, but never
re-sent when the WebSocket reconnects mid-take — so after any reconnect
(idle-proxy timeout, sleep/wake, flaky wifi), the "Guest is recording" pill
silently and permanently shows false for the rest of that take, even though
the recording is fine. `talking` (the Talk feature) had the identical bug
and was fixed via `RoomTabs.svelte`'s `resyncDuck()`, called from
`connectWs()`'s `onopen` — a hand-written, one-off special case. `recording`
never got the same treatment. The fix generalizes the pattern instead of
writing a second special case, and gives `connectWs()` — currently an
untestable, tangled closure — a real seam for the first time.

---

## Ticket 1 — `src/lib/room-connection.js`, built and tested in isolation

**Goal:** a new deep module, zero risk to ship because nothing calls it yet.
Don't touch `+page.svelte` in this ticket at all.

**Interface:**

```js
export function createRoomConnection({
  createSocket,      // () => WebSocket-like object — injected, so tests use a fake
  onOpen,            // () => void — called after every successful connect (first or reconnect)
  onMessage,         // (msg: object) => void — called with the parsed JSON payload
  onStatusChange      // (status: 'connecting'|'connected'|'disconnected') => void
}) {
  return {
    connect,          // () => void — idempotent: no-op if already connecting/connected
    send,             // (payload: object) => void — no-op if not connected (mirrors today's wsSend guard)
    registerResync,    // (fn: () => void) => void — fn is called once per successful connect, after onOpen
    disconnect         // () => void — for onDestroy cleanup; suppresses the reconnect loop
  }
}
```

Behavior to implement (TDD — write the test, watch it fail, implement):

1. **Dispatch**: `connect()` uses `createSocket()` to get a socket, wires
   `onmessage` to `JSON.parse` + call `onMessage(msg)` (swallow parse
   errors, same as today's `try { msg = JSON.parse(e.data) } catch { return }`).
2. **Reconnect policy**: on close (unless `disconnect()` was called), schedule
   a reconnect with **exponential backoff + jitter**, not today's flat 3000ms.
   Suggested shape: `nextDelay(attempt) = min(cap, base * 2^attempt) * (0.5 + Math.random()*0.5)`,
   `base=1000`, `cap=15000`. Reset `attempt` to 0 on every successful `onOpen`.
   Write `nextReconnectDelay(attempt)` as a **pure exported function** so it's
   directly unit-testable without touching the socket at all.
3. **Resync registry**: `registerResync(fn)` appends to an internal list.
   After every successful connect (`onOpen` fires, i.e. the socket's own
   `onopen`), call every registered fn, **in registration order**, each
   wrapped in its own `try/catch` so one throwing callback never blocks the
   next (today `resyncDuck` is wrapped, `syncClock` isn't — fix that
   inconsistency here, uniformly, for free).
4. **Status**: call `onStatusChange` with `'connecting'` before the socket is
   constructed, `'connected'` on open, `'disconnected'` on close/error.

**Testing:** a fake socket matching `tests/unit/ws-test-helpers.js`'s shape
(that file is server-side and won't directly reuse, but copy its *pattern* —
a plain object with `.send`, `.close`, and the ability for the test to
trigger `.onopen()`/`.onmessage()`/`.onclose()` manually). New file:
`tests/unit/room-connection.test.js`. Cover at minimum:
- `connect()` is idempotent (calling twice while connecting/connected doesn't
  create a second socket)
- `onMessage` fires with the parsed payload; malformed JSON is silently
  dropped, doesn't throw
- `send()` calls the socket's `.send()` with `JSON.stringify(payload)`; is a
  no-op if not connected
- `registerResync` callbacks fire, in order, after every successful connect
  — including on a *second* connect (reconnect), not just the first
- a resync callback that throws doesn't prevent the next one from running
- `nextReconnectDelay(attempt)` (pure function, separate test block):
  increases with attempt, is capped, includes jitter (assert it's not the
  same value on repeated calls with the same attempt, and stays within
  `[base*2^attempt*0.5, cap]` roughly)
- `disconnect()` suppresses any pending scheduled reconnect

**Acceptance:** `npx vitest run tests/unit/room-connection.test.js` green,
`npx svelte-check` clean, `npm run build` clean. Commit as its own commit.
Nothing else in the app changes in this ticket — `+page.svelte` still uses
its own `connectWs()` untouched.

---

## Ticket 2 — wire `room-connection.js` into `+page.svelte`, zero behavior change

**Goal:** replace `connectWs()`'s internals with `createRoomConnection()`
from ticket 1, preserving **every existing message type and side effect
exactly** — presence, pong/clock-sync, clap, `tabs_state`/`tab_video`/
`tab_text`, `yt_duck`, error. This ticket adds **no new tests** of its own —
its acceptance criterion is that nothing regresses. Do not add the
`recording`/`talking` resync yet — that's ticket 3, so this ticket's diff is
purely structural and easy to review in isolation.

Read `src/routes/rec/[slug]/+page.svelte`'s WEBSOCKET section
(`connectWs`, `wsNotifyState`, `wsSend`, `syncClock`, the `onmessage`
if-chain, `onclose`/`onerror`) and the state it closes over (`ws`,
`wsStatus`, `peers`, `clockOffset`, `_clockSamples`, `_pendingPings`,
`pendingClaps`) before starting — don't guess at current behavior, read it.

Steps:
1. Instantiate `createRoomConnection` in place of the raw `WebSocket`
   construction. `onMessage` becomes the existing `onmessage` if-chain body,
   unchanged, just moved. `onOpen` becomes: `send({type:'join', ...})`, then
   the existing `roomTabs?.resyncDuck?.()` try/catch, then `syncClock()` —
   same three calls, same order, just now running as the injected `onOpen`.
2. Replace `wsSend`/direct `ws.send(...)` call sites with the new module's
   `send()`.
3. `wsStatus` updates move to the `onStatusChange` callback.
4. `onDestroy`'s `ws?.close()` becomes the new module's `disconnect()`.
5. Do **not** yet call `registerResync` for anything — `resyncDuck` keeps
   running exactly where it already does, inside `onOpen`, unchanged. That
   migration is ticket 3's job specifically so this ticket stays pure
   plumbing.

**Acceptance:** full existing suite green — `npx vitest run` (all files, not
just the new one), `npx svelte-check`, `npm run build`, and if you have the
means to run it, `npx playwright test` (or at minimum the room/tabs/talk
specs) — since this ticket's whole point is "nothing changed," the existing
e2e coverage for clap, tabs, talk should still pass unmodified. If anything
in the existing suite goes red, that's a real regression from this ticket —
fix it before moving on, don't paper over it.

---

## Ticket 3 — the actual fix: resync `talking` and `recording`, plus regression tests

**Goal:** migrate `talking` onto `registerResync`, add `recording` to the
same mechanism (the bug fix), and prove both with tests.

1. In `RoomTabs.svelte`, keep `resyncDuck()` as the function that knows
   *what* to send (`{type:'yt_duck', talking:true}` if locally holding
   Talk) — but stop calling it directly from `+page.svelte`'s `onOpen`.
   Instead, `+page.svelte` calls `roomConnection.registerResync(() =>
   roomTabs?.resyncDuck?.())` once, e.g. right after `roomTabs` binds.
2. Add a new resync registration for recording: `registerResync(() => {
   if (recordingState === 'recording') wsNotifyState('recording') })`.
   This is the actual fix — read it back against the bug description above
   and confirm it closes the gap.
3. **Unit test** (extend `tests/unit/room-connection.test.js` or a new
   integration-style test if `+page.svelte`'s logic can't be reached
   directly without a component-test harness — check what's available
   before assuming jsdom/`@testing-library/svelte` exists; per the
   architecture review, it currently doesn't, so if you need one, that's
   its own small addition, keep it minimal): verify that a resync callback
   registered for "send recording_state if currently recording" actually
   fires and sends on reconnect, and does *not* send when not recording.
4. **Playwright e2e** (this is the real proof, and the scenario the
   original bug report cared about): start a recording (stub the save
   picker per whatever pattern `tests/playwright/talk.spec.js` or similar
   already uses for audio/file mocking), force-close the WebSocket from the
   test (or simulate the server dropping the connection), wait for the
   automatic reconnect, assert the recording pill still shows "Recording"
   on both host and guest views. Do not sleep for the real proxy idle
   timeout — trigger the reconnect directly (close the socket) rather than
   waiting for it to time out on its own.

**Acceptance:** new unit + e2e tests both fail without the fix (verify this
— comment out the `registerResync` call for recording, confirm the e2e test
goes red, then put it back) and pass with it. Full suite green. This is the
ticket that actually closes the bug — don't consider it done until the new
e2e test would have caught the original production incident.
