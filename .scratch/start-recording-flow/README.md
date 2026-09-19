# Start recording flow

Work the **frontier**: the lowest-numbered ticket whose blockers are done.
If you are told "work on the start-recording-flow tickets," start at
`issues/01` and continue only after that ticket's checklist is fully
checked. Do not batch several tickets' implementations and then sprinkle
tests on at the end.

## What this line is

Streamlines the **existing** host/guest start-recording flow. This is not
a rewrite and not new architecture — every ticket below extends working
modules that already exist:

- `src/lib/recording/capture-writer.js` — the local WAV write path. Hard
  invariant (AGENTS.md): silence is only ever written from an explicit,
  measured gap (`notifyDeviceGap`), never inferred from write timing.
  Anything that shows recording health (including any new sound-check UI)
  must be sourced from `onWritten` (confirmed-written data), never the
  live mic signal.
- `src/lib/recording/audio-engine.js` — mic capture; `getUserMedia` is
  called from `initAudioEngine()` at room join (`onMount`), **not** at
  Start Recording. This is why a room-relayed "start" message can flip a
  peer's recording state without a fresh browser gesture — the gesture
  already happened at join.
- `src/lib/recording/clock-sync.js` — ping-burst client/server clock
  offset, already used to schedule the existing manual Clap tone and
  Watch Together playback at the same physical instant on every peer
  (`triggerAtMs`, corrected by `offset` into local time).
- `src/lib/recording/recording-check.js` + `RecordingCheckModal.svelte` —
  the existing single-person mic check: read a sentence, listen back to
  what was actually **written** (never live), confirm or reject.
- `src/lib/recording/recording-check-share.js` — relays a capped preview
  of that listen-back clip to the host over the room WebSocket (shipped
  in commit `e0bf320`). Not a live talk path.
- `src/lib/room/room-connection.js` — one WebSocket per browser, backoff +
  jitter reconnects. Any state that's true locally but not yet known to
  the server **must** re-announce itself on every successful connect via
  `room.registerResync(fn)` — skipping this is exactly how the Recording
  pill went stuck-wrong after a reconnect once already (see AGENTS.md).
- `src/lib/server/ws-rooms.js` — server-side room/message routing.
- `src/lib/recording/RecordControls.svelte` — existing Start/Stop button
  and the manual "Sync Tone Marker" (Clap) button.

New functionality belongs **inside** these modules, or the small number of
new modules a ticket explicitly names — not scattered into fresh one-off
files/components for things that logically belong together. In
particular, all sound-check sequencing (host's turn, guest's turn, the
"stay quiet" state) is one piece of logic and should live in one place,
not spread across ad hoc components.

## Locked product decisions

- **Local recording is the resilience copy, not "the backup" in the weak
  sense.** Its job is to survive the server or internet going down —
  worst case, host and guest reconstruct the episode from a call using
  local files. It is not framed to the guest as busywork they must
  personally deliver: in the normal case the automatic server-copy
  upload (already existing — `serverCopyUploadState`,
  `hasIncompleteServerCopyUpload` in `+page.svelte`) is what the host
  actually uses, via the existing `ServerCopyFilesModal`. The guest never
  needs to send their local file anywhere unless that upload failed.
- **The save-location picker (`showSaveFilePicker`) moves to room join**
  and fires once. It cannot be pre-armed or fired without a direct user
  gesture (browser constraint) — the join step's own click is that
  gesture. The resulting `FileSystemFileHandle` is reused for every
  take/retake in that room visit; `startRecording()` in `+page.svelte`
  stops calling `showSaveFilePicker` itself.
- **Recording starts writing immediately but doesn't count as the take
  until the synced clap fires.** A failed check discards nothing real —
  nothing meaningful was written yet — and a retake gets a **new
  filename** against the same handle (`take2.wav`, etc.), never an
  overwrite.
- **Start is host-triggered; each person clears their own check by
  self-confirming** (existing "Yes, continue" pattern) — there is no
  separate blocking "host wants to start, guest must click OK" gate on
  top of that. Each person's own check-and-confirm already is the
  awareness/consent checkpoint.
- **Stop is host-triggered and synced to both,** gated by one "are you
  sure — stops the take for both" confirmation (stopping is final and
  room-wide, unlike start). The host's own stop never blocks on the
  guest's side acknowledging it — a disconnected/unresponsive guest is
  surfaced, not waited on.
- **The synced layer is optional dressing over local recording, never a
  dependency of it.** With the room WebSocket down, each peer's own
  Start/Stop and mic check must keep working solo — no shared clap, no
  cross-party sequencing, no host-trigger — recording capability itself
  never depends on room connectivity.
- **The clap/countdown marker is the same mechanism at both ends of the
  take** — once, synced, when the sound check passes (start), and again
  before the file actually closes (stop, followed by a 2s count) — both
  built on `clock-sync.js`'s existing `triggerAtMs` pattern, not a new
  timing mechanism.

## Definition of done (every ticket)

1. **TDD.** Red → green per seam listed in the ticket. Tests assert
   user-visible or public-module behaviour, not private helpers, CSS
   classes, or "the function called the mock." Expected values are
   literals/fixtures, not a reimplementation of the code under test.
2. **Coverage.** `npm run test:coverage` — new branches this ticket
   introduced are covered; overall coverage does not drop. Do not add
   tests that only exist to inflate a number.
3. **E2E.** Playwright spec(s) named in the ticket, using existing
   helpers/conventions under `tests/playwright`. Exercise the flow a
   host and guest would actually hit, including the ticket's failure/
   edge path — a screenshot is not an e2e test.
4. **Docs.** Update `CONTEXT.md` (glossary) and `AGENTS.md` (invariants)
   so a later agent doesn't have to rediscover behaviour from git blame.
   Name new terms (e.g. "Synced Recording Session," "Take Marker") in
   `CONTEXT.md` the first ticket that introduces them.
5. **Shape.** Deepen the existing modules named above; do not grow a
   god-component or scatter one feature's logic across several new
   files. One definition of "is this a real take yet," one definition of
   "what does a synced start/stop message look like" — not one per
   ticket that touches it.

## Checks to run before handing off a ticket

- `npx vitest run` (and `npm run check:standalone` if you touched
  anything `ws-rooms.js` imports)
- `npm run test:coverage`
- the Playwright spec(s) this ticket added or extended
- `npx svelte-kit sync && npx svelte-check` if you touched `.svelte` or
  page/server files
