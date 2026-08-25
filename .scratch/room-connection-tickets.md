# Room connection — ticket 2 (do this next)

Work on the current branch. Ticket 1 is already committed. Do not re-implement `src/lib/room-connection.js`. Do not start ticket 3.

**Why this series exists (do not fix the bug here):** after a mid-take WebSocket reconnect, the peer “recording” pill goes false and stays false. `recording` is client-owned and is only sent once from `startRecording()` via `wsNotifyState('recording')`. Talk already has a one-off `roomTabs?.resyncDuck?.()` in `onopen`. Ticket 3 moves both onto `registerResync`. This ticket is plumbing: same messages, new owner.

---

## Ticket 1 — done

- `src/lib/room-connection.js` — `createRoomConnection({ createSocket, onOpen, onMessage, onStatusChange })` returns `{ connect, send, registerResync, disconnect }`. Also exports `nextReconnectDelay`.
- `tests/unit/room-connection.test.js` — 13 tests. Keep them green. Do not expand them here.
- `send(payload)` `JSON.stringify`s. Pass objects, never a pre-stringified string.
- `send` no-ops unless `readyState === 1`.
- Reconnect is backoff + jitter on `onclose` only. `disconnect()` cancels it.
- `registerResync` fns run after `onOpen`, each in its own try/catch. **Register none in this ticket.**

Sanity check before editing: `npx vitest run tests/unit/room-connection.test.js`

---

## Ticket 2 — wire it into the page, no new tests

**Edit:** `src/routes/rec/[slug]/+page.svelte` (import + WEBSOCKET section + the raw `ws.send` call sites). Do not change `src/lib/RoomTabs.svelte` or `room-connection.js` unless wiring exposes a real bug.

**Goal:** `connectWs()` delegates to one `createRoomConnection` instance. Diff should read as “same calls, new owner.” No new tests; acceptance is no regressions.

### Read before writing

WEBSOCKET block (~704–774) plus every send site. Today:

| Site | Behavior to preserve |
|---|---|
| `connectWs` guards | bail if `sessionDestroyed` or `!data.authenticated`; no-op if `ws` is OPEN/CONNECTING |
| URL | `` new WebSocket(`${proto}//${location.host}/ws?slug=${data.slug}`) `` with `proto` from `location.protocol === 'https:' ? 'wss:' : 'ws:'` |
| `onopen` order | join `{ type: 'join', name: getJoinName(), clientId }`, then `try { roomTabs?.resyncDuck?.() } catch {}`, then `syncClock()` |
| `onmessage` | `presence` → `peers`; `pong` → clock samples; `clap`; `tabs_state` / `tab_video` / `tab_text` / `yt_duck` on `roomTabs`; `error` logs |
| `wsSend` | `RoomTabs send={wsSend}` |
| `wsNotifyState` | `{ type: 'recording_state', state }` |
| `sendClap` | `{ type: 'clap' }` via raw `ws.send` |
| `syncClock` | three `{ type: 'ping', seq, sentAt }` via raw `ws.send` |
| `onDestroy` | `sessionDestroyed = true` then `ws?.close()` |
| session start (~821) | still calls `connectWs()` |

The module does not know about auth or `sessionDestroyed`. Keep those guards on the page wrapper.

`onMessage` receives the **parsed object**. Do not `JSON.parse` again. Do not stringify before `send()`.

### How to wire it

One instance at script scope (not inside `connectWs`), or ticket 3 has nowhere stable to hang `registerResync`.

- `createSocket`: the existing URL, `() => new WebSocket(...)`
- `onOpen`: join via `room.send(...)`, then the existing resyncDuck try/catch, then `syncClock()`. Same three calls, same order.
- `onMessage`: existing if-chain body, moved, not rewritten
- `onStatusChange`: `wsStatus = status`

`connectWs()`: existing guards, then `room.connect()`. Drop the local OPEN/CONNECTING check; `connect()` is already idempotent.

Replace every `ws.send` / `socket.send` / `ws?.close()`:

- join, `wsSend`, `wsNotifyState`, `sendClap`, `syncClock` → `room.send({ ... })`
- `onDestroy` `ws?.close()` → `room.disconnect()` (keep `sessionDestroyed = true` first)

`RoomTabs` still gets `send={wsSend}`. `wsSend` can be a one-liner over `room.send`.

Drop `let ws` once nothing reads `ws.readyState`. A leftover `ws.` is a missed call site.

### Do not

- Call `registerResync`. `resyncDuck` stays in `onOpen`.
- Add tests.
- Put the 3000ms `setTimeout(connectWs, 3000)` back. Reconnect timing **will** change to backoff + jitter. That is expected. Message handling and the on-open trio must not.

### Checks

1. Grep the page: no `new WebSocket`, no `ws.send`, no `socket.send`, no `setTimeout(connectWs`, no `ws?.close`. Wrapper names (`connectWs`, `wsSend`) can stay.
2. Join payload still `{ type: 'join', name: getJoinName(), clientId }`.
3. On-open order still join → resyncDuck → syncClock.
4. `npx vitest run` (all files).
5. `npm run build`.
6. Playwright: at least `tests/playwright/clap.spec.js`, `talk.spec.js`, `presence.spec.js`, `add_tab.spec.js`, `recording_status.spec.js`. Full `npx playwright test` if you can. Red is a wiring bug; fix it.
7. `svelte-check` is not in package.json. Do not block on `npx svelte-check` failing to install.

Commit this ticket alone. Stop.

---

## Ticket 3 — not now

Move `resyncDuck` off `onOpen` onto `registerResync`. Add a recording resync: if `recordingState === 'recording'`, send `recording_state` again. Prove it with a unit test and a Playwright reconnect that **closes the socket** (do not wait for proxy idle). That is the pill bug. Do not start until ticket 2 is green.
