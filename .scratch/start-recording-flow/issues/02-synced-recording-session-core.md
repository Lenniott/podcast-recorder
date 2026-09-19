# 02: Synced recording session core (host-triggered, offline-safe)

**Read first:** this folder's README, especially "The synced layer is
optional dressing over local recording, never a dependency of it."
Glossary to add: **Synced Recording Session** (the room-level state this
ticket introduces).

**What to build:** Today, Start/Stop (`RecordControls.svelte`'s
`onToggleRecording`) is purely local — each peer starts/stops their own
`MediaRecorder`/capture-writer independently, with no coordination beyond
the `myPeerIsRecording` presence flag. Introduce a room-level **Synced
Recording Session**: when the host presses Start, a message goes over the
room WebSocket and both host's and guest's local recording start
together; the same for Stop. This ticket is deliberately bare — no sound
check, no clap, no confirmation dialog yet (those are tickets 03/04/06
layered on top). The end-to-end demoable behaviour is: host clicks Start
→ both browsers begin writing → host clicks Stop → both browsers stop.

The offline fallback is not a follow-up bolt-on — build and test it in
this same ticket: if the room WebSocket is disconnected, each peer's own
Start/Stop button must still work exactly as it does today (solo, no
coordination). A synced-start message that never arrives (peer offline)
must not leave that peer's UI claiming it's recording when it isn't, and
must not stop the *other* peer's independent ability to hit their own
Start button.

**Where to look:** `src/lib/room/room-connection.js` — the `send`/
`registerResync` pattern already used for other cross-peer state (see the
existing Recording-pill-after-reconnect lesson in AGENTS.md: any state
true locally but not yet server-known must re-announce on reconnect,
registered via `room.registerResync(fn)` — do not hand-roll a one-off
fix for this new state). `src/lib/server/ws-rooms.js` for how existing
message types (e.g. `clap`, presence) are routed/broadcast — model the
new start/stop message the same way. `src/routes/rec/[slug]/+page.svelte`
owns `recordingState`, `myPeerIsRecording`, `wsStatus`, and calls
`toggleRecording` — this is where session-phase state most likely lives,
passed down to `RecordControls.svelte` as today. `audio-engine.js`'s
`getUserMedia` already ran at join (see README) — starting a peer's own
recording from a received WS message needs no fresh user gesture, this is
not blocked by browser permission rules.

**Out of scope:** the actual sound-check sequence (03), the clap/
countdown marker (04), and the stop confirmation dialog (06) are separate
tickets that consume the message types/state this ticket defines. Don't
build them here — build the plumbing they'll attach to.

**TDD seams:**

1. Unit: new `ws-rooms.js` message type(s) for session start/stop —
   server relays host's start/stop to all peers in the room; a
   non-host-originated start/stop is rejected or ignored per whatever
   host-authority check already gates other host-only actions.
2. Unit: client-side session-phase state responds to the relayed
   message by driving local recording start/stop the same way the
   existing local toggle does — do not duplicate `capture-writer.js`
   invocation logic, call the same path `toggleRecording` already uses.
3. Unit: `registerResync` — a peer that reconnects mid-session
   re-announces/recovers the correct phase, matching the existing
   Recording-pill-survives-reconnect behaviour, not a new stuck-wrong
   case.
4. Unit: with `wsStatus !== 'connected'`, pressing a peer's own local
   Start/Stop still works, produces a real local recording, and does not
   throw/hang waiting for a room round-trip.
5. E2E: two browser contexts (host + guest) in one room; host clicks
   Start; assert guest's recording state flips to recording without the
   guest clicking anything; host clicks Stop; both stop. Second E2E:
   simulate the guest's WebSocket disconnected (existing test
   infrastructure for `wsStatus`, if any, or force via network
   interception); guest's own Start/Stop still functions solo.

**Blocked by:** None — this is the foundational ticket; 03, 04, and 06
depend on it.

**Status:** ready-for-agent

- [ ] Host's Start triggers recording start on both host and guest
      browsers via one room-level message.
- [ ] Host's Stop triggers recording stop on both browsers the same way.
- [ ] A guest cannot trigger a synced start/stop for the room (matches
      "host controls recording" decision) — attempting to does not
      desync the host's view of session state.
- [ ] Session-phase state re-announces itself on reconnect via
      `room.registerResync`, verified by a reconnect test, not just
      inspection.
- [ ] With the room WebSocket disconnected, each peer's own local Start/
      Stop still fully works — recorded audio is produced, nothing hangs
      or silently no-ops.
- [ ] No existing single-peer recording behaviour regresses (existing
      `myPeerIsRecording`, `recordingState`, stats bar all still correct).
- [ ] TDD on the seams above.
- [ ] Coverage: connected/disconnected × host-triggered/guest-attempted ×
      reconnect-mid-session.
- [ ] E2E: two-peer synced start/stop; solo fallback with WS down.
- [ ] Docs: `CONTEXT.md` **Synced Recording Session** entry; `AGENTS.md`
      "Keeping host and guest in sync" section updated to name this new
      state as one that must use `registerResync`.
