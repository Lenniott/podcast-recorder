# 06: Confirmed, synced stop with tail marker

**Status:** done

**Read first:** this folder's README. Then `src/lib/recording/recording-session.js`
and `src/lib/recording/take-marker.js`.

## Modules

Two existing modules, no new one.

`createRecordingSession` learns the stop gate: confirm, cancel, and
"the other side may still be recording." `createTakeMarker` learns a tail
that reuses `scheduleTakeMarker`. The room page renders the two strings
this module exports and calls `confirmStop` / `cancelStop`.
`RecordControls.svelte` stays the Start/Stop button it already is.

## Why the tail is not `requestStart`

`createTakeMarker().requestStart` records a start. It returns immediately
once `requested` is set, and its boundary writes `startSample` and
`takeReady`. The tail is a second instant on the same take. Call
`scheduleTakeMarker` (the function) from a new `requestTail`. Leave
`requestStart`, `takeReady`, and `startSample` alone.

The server already rebuilds a `take_marker` broadcast and drops every
field except type, timestamp, `triggerAtMs`, and `from`
(`ws-rooms.js`, the `clap` / `take_marker` branch). A client-set lead
would not survive that rebuild. The server chooses the lead: `edge: 'end'`
schedules `triggerAtMs` at now + 2000; a missing edge or `edge: 'start'`
stays the existing start lead (`TAKE_MARKER_LEAD_MS`, 3000). Copy `edge`
onto the broadcast only when it is `'end'`.

`createRecordingSession.onToggle` today sends `phase: 'idle'` and calls
`stopLocal` in the same turn. A confirm dialog that then calls `onToggle`
stops both peers at confirm time and skips the tail. `confirmStop` sends
the end marker, and `stopLocal` runs from the marker boundary. The session
phase stays `recording` until that boundary. `recording_session` gains no
new phase.

## Interface

```js
// recording-session.js
export const STOP_BOTH_CONFIRM =
  'Stop recording for both of you? This ends the take.'

export const OTHER_SIDE_UNCERTAIN =
  'The other side may still be recording.'

onToggle()
  // idle → start, as today.
  // recording, and the synced host path (connected + host) →
  //   set awaitingConfirm, send nothing, do not call stopLocal.
  // recording, any other case (socket down, or this peer is the guest) →
  //   stopLocal immediately, as today. awaitingConfirm stays false.
  //   Guest stop remains local-only. It does not stop the host.

confirmStop()
  // No-op unless awaitingConfirm is true.
  // Clears awaitingConfirm.
  // Calls requestTail() on the take-marker module (injected).
  // Does not call stopLocal in this turn.
  // Does not wait for a guest message.

cancelStop()
  // Clears awaitingConfirm. Phase stays recording.
  // stopLocal has not been called. Nothing was sent.

// After confirmStop, the tail boundary (below) is what calls stopLocal
// and then send({ type: 'recording_session', phase: 'idle' }).
// That callback does not call onToggle (onToggle would open the dialog again).

otherSideUncertain
  // false until the tail fallback below runs.
  // true once this peer stopped locally because the end-marker broadcast
  // never came back. The page shows OTHER_SIDE_UNCERTAIN when this is true.
  // The page shows STOP_BOTH_CONFIRM while awaitingConfirm is true.
```

```js
// take-marker.js
requestTail({ synced })
  // Once per take. A second call is a no-op (the start marker's once-guard
  // is a separate flag — a start already having fired must not block the tail).
  // synced + connected + host → send({ type: 'take_marker', edge: 'end' }).
  // The broadcast echo (and the guest's copy of it) is what arms the tone
  // and the boundary, via scheduleTakeMarker({ triggerAtMs, offset, ... }).
  // onBoundary calls the injected onTail, once.
  // Solo / socket down → scheduleTakeMarker locally at now + 2000 with offset 0.
  // Does not change takeReady or startSample.

receive({ triggerAtMs, offset, edge })
  // edge 'end' arms the tail. Any other edge stays the start path ticket 04 built.
  // A second end-edge receive is ignored.
```

Host hang rule, inside `requestTail` / the session boundary wiring:

The host's file close is armed by the broadcast echo, same as the guest,
so both use one `triggerAtMs`. If that echo has not arrived 500ms after
the 2000ms lead (2500ms after confirm), the host runs the boundary
anyway: `stopLocal` once, send `idle` once, `otherSideUncertain = true`.
A guest ack is not a thing this module waits for. If the echo arrives
after the fallback already stopped the file, `receive` does not stop a
second time and does not clear `otherSideUncertain`.

Inject `now`, `setTimeoutFn`, and `clearTimeoutFn` the way `createTakeMarker`
already does. Tests pass a fake timer and assert the literal delays
`2000` and `2500`.

## Tracer bullets

One failing test, then the code that passes it.

1. Synced host, state recording: `onToggle` sets `awaitingConfirm`, does not call `stopLocal`, does not `send`.
2. `cancelStop` clears `awaitingConfirm`. `stopLocal` was not called. Nothing was sent.
3. `confirmStop` sends `{ type: 'take_marker', edge: 'end' }` once and does not call `stopLocal` in that turn. `requestStart` is not called.
4. An end-edge echo `{ triggerAtMs, edge: 'end' }` arms `scheduleTakeMarker` with delay `2000` (literal: triggerAtMs = now + 2000, offset 0). The boundary callback calls `stopLocal` once and sends `{ type: 'recording_session', phase: 'idle' }`. `takeReady` is still false and `startSample` is still 0.
5. A second end-edge echo does not schedule again and does not call `stopLocal` again.
6. No echo: advancing the fake clock to 2500ms calls `stopLocal` once, sends `idle` once, and `otherSideUncertain` is true. A late echo after that does not call `stopLocal` again.
7. Socket disconnected: `onToggle` while recording calls `stopLocal` immediately. `awaitingConfirm` is false. No `take_marker` is sent.
8. Server unit test, beside the existing `take_marker` coverage in `tests/unit/ws-rooms.test.js`: an `{ type: 'take_marker', edge: 'end' }` from the host is broadcast with `edge: 'end'` and `triggerAtMs` 2000ms ahead of the stubbed clock. `{ type: 'take_marker' }` with no edge is broadcast without `edge: 'end'` and 3000ms ahead, matching the start marker.
9. Playwright, new `tests/playwright/synced_stop.spec.js`, two browsers: host clicks Stop, the confirm string is visible, Cancel leaves both recording. Confirm again; both return to idle after the countdown. A second case closes the guest page before confirm; the host still returns to idle and the uncertain string is visible.

## Rejected shapes

A confirm component that calls today's `onToggle`. A second tone scheduler beside `scheduleTakeMarker`. A `stopping` phase on `recording_session`. A promise that resolves when the guest acknowledges. Reusing `requestStart` for the tail.

## Docs, when the behavior is green

`CONTEXT.md` **Take Marker**: it is also the tail, 2 seconds before both files close, same `triggerAtMs` path as the start marker. **Synced Recording Session**: a synced Stop asks the host to confirm first; the host's file still closes if the guest's browser is gone, and the host is told the other side may still be recording.

`AGENTS.md`: a synced stop closes the host's file on the marker instant (or the 2500ms fallback). It does not wait on the guest.

## Done when

- [x] Synced Stop shows `STOP_BOTH_CONFIRM` and sends nothing until confirm.
- [x] Cancel leaves both sides recording.
- [x] Confirm fires one end-edge Take Marker; both sides stop at that instant, about 2 seconds later.
- [x] The host's file still closes, once, when the guest is gone, and `OTHER_SIDE_UNCERTAIN` is shown.
- [x] A solo stop with the socket down still stops immediately, with no dialog and no marker.
- [x] `requestStart` / `startSample` / `takeReady` behave as ticket 04 left them.
- [x] Tracer bullets 1–9 are green, in that order.
- [x] `CONTEXT.md` and `AGENTS.md` updated as above.

Note on bullet 9's second case: the server echoes `take_marker` to the
sender too, so closing the guest page alone never costs the host its
end-edge echo. The spec closes the guest *and* drops the host's end-edge
frame (`routeWebSocket`) to reach the 2500ms fallback that shows
`OTHER_SIDE_UNCERTAIN`. A connected host alone in the room also gets the
confirm dialog (connected + host is the synced path).
