# Check Turn coordinator implementation

The coordinator composes the existing confirmed-write check buffer and turn
sequence. Room recording control owns the authoritative session ID, round ID,
and revision. The page owns capture destinations, preview object URLs, and
marker scheduling. Dismissal is local presentation state; file rotation never
calls back into check policy.

## Behavioral evidence

The paired harness in `tests/unit/check-turn-coordinator.test.js` connects two
real coordinators through `createRoomRecordingState`. Transport delivery and
retake promises are controlled; neither internal check module is mocked.

Behavioral red/green checkpoints captured during implementation:

- Paired host/guest start: own-check visibility was absent, then host/guest
  sequencing and one controlling marker passed.
- Preview replay after confirmation: no PCM was published after buffer cleanup;
  retaining the confirmed preview made the test pass.
- Reconnect round identity: a disconnect/rejoin changed round 1 to round 3;
  retaining known participant progress fixed it.
- Stale/unfinished-round marker requests: two invalid requests scheduled markers;
  authoritative identity and completion validation rejected both.
- All sockets disconnected: reconnect allocated a different session UUID;
  retaining the existing room recording state through a 60-second grace fixed it.
- Stop during a cancelled file roll: the browser showed idle but emitted no
  worklet Stop command. The no-writer Stop path now stops capture explicitly.
- Starting capture in an existing retake round: the coordinator unnecessarily
  rolled its freshly opened file; initial round adoption now uses that file.
- Reinitialized room recovery: a new authoritative session UUID was ignored,
  leaving a check unable to advance. Recovery now adopts that session while
  retaining the local file and invalidating older effects. A pending retake
  stays pending until its replacement operation returns ready.
- Browser preview presence: opening the guest turn failed to publish `checking`;
  announcing changed check visibility restored the existing presence behavior.

Two isolated source mutations were tested against copied modules and restored:
accepting a stale retake continuation and allowing replay to reset local dismissal.
Both produced failing focused behavioral tests. The production module was never
mutated for this check.

## Acceptance map

`C` means `tests/unit/check-turn-coordinator.test.js`; `B` means
`tests/playwright/check_turn.spec.js`. Other files are named explicitly.

| Plan scenario | Executable evidence |
| --- | --- |
| paired | C: offers host then guest checks; B: synced start |
| own_exit (host/guest, close/Skip/Escape) | B: both escape check screens (click and Escape); the close control is the accessible Skip microphone check button |
| waiting_exit (host/guest, Back/Escape) | B: both escape check screens; host can leave waiting (both actions) |
| no_reopen | C: both can dismiss locally; B: socket replay and a changed turn |
| both_exit | B: both escape check screens |
| retake | C: retake dismissal survives deferred ready; `local_copy.spec.js`: synced guest reject and host reject with byte comparison |
| retake_exit | C: deferred-ready dismissal; B: held ready I/O |
| stop_race (sealing/opening/ready callback) | B: held close/open I/O; C: Stop between ready and queued continuation |
| retake_failure (failed/throw) | C: retake failed/throws parameter cases |
| duplicates | C: paired completion replays Confirm/resync; deferred retake repeats rejection; B: repeated Escape in the room |
| stale_round | C: old round turns and rejection requests |
| new_round | C: solo-passed guest joins a genuinely newer host-led round |
| new_session | C: older recording-session snapshot; new recording invalidates old retake results; `ws-rooms.test.js`: old-session marker requests |
| host_returns | C: solo-passed guest joins; `synced_recording_session.spec.js`: guest solo-passed then host returns |
| peer_leaves (host/guest) | C: h/g no longer waits on departed peer; existing room-control departure tests |
| peer_stays_silent | C: h/g can hide a wait with no reply |
| reconnect | C: reconnect retains session/round; B: socket replay; `ws-rooms.test.js`: all sockets briefly disconnect |
| old_presence_after_stop | C: stopped lifecycles reject late presence and audio |
| preview | C: confirmed preview replay, late written audio; existing `recording-check.test.js` buffer tests; `recording_check_preview.spec.js` |
| late_audio | C: rejected attempt cannot refill fresh check; stopped lifecycle test |
| stop_access | B: guest Stop request acceptance finalizes both recorders |
| dialog_priority | C: priority dialogs yield; B: guest Stop request decline leaves Show check |
| audio_permission | `synced-recording-session.test.js`: cancels a start waiting on browser audio; `audio_needs_click.spec.js` proves actual browser wake-up behavior |
| dispose | C: disposal prevents late retake, preview, marker, view, and room effects |

The browser retake tests hold real worker operations while keeping actual OPFS
writes. The Local Copy rejection regression compares retained audio bytes against
the prefix read before rejection. No saved attempt is deleted or truncated.

## Validation

Final validation results are recorded after the last application changes. Browser
runs use fresh isolated servers (`E2E_PORT=5188 E2E_WS_PORT=3018`) because Vite HMR
does not reload the WebSocket server. The original isolated verification did not restart the existing server; the follow-up below corrects that runtime mismatch.

Final results (2026-11-02):

- `npm test`: 66 files, 1,238 tests passed, including the standalone Node import check.
- Required recording browser set plus escape/replay/retake regressions: 31 passed
  with retries disabled on fresh isolated servers (2.4 minutes).
- `npm run build`: passed.
- Svelte check: zero errors and zero warnings.
- Isolated stale-retake and replay-dismissal mutations: both detected; restored
  focused coordinator tests pass.
- `git diff --check`: passed.

The last browser run had no concurrent builds or application edits. Earlier
runs exposed development-page reload flakes; the final clean run needed no retry.


## Follow-up: guest approval on the running local app

The reported guest-only start and disabled host control reproduced on
`localhost:5173` with the original development server. Its WebSocket process
was still running the older sender-excluding relay:

1. Guest sent a start request; host received the request.
2. Host sent `recording_session: recording` on approval.
3. Only the guest received that phase; the host received no room acknowledgement.
4. Presence showed host capture false and guest capture true, without the new
   authoritative session/check metadata. The updated host therefore kept waiting.

Restarting the existing development server loaded the room-owned recording
implementation. Repeating the same browser flow then delivered authoritative
recording snapshots to both participants, started both files, opened the host
check first, and left the host Stop control enabled. No additional recording
controller or participant-specific start path was introduced.

The guest-request regression in `synced_recording_session.spec.js` now asserts
that both controls are enabled and both actual OPFS files contain audio before
either participant completes a microphone check. A temporary filtered protocol
probe reproduced the failure and confirmed the fix, then was removed.

Follow-up verification on the actual development app (`localhost:5173`): all
nine room-control and synced Stop cases passed across two batches, with retries
disabled. The initial batch's final four cases hit the existing login rate limit
before reaching recording; all four passed after that window cleared. The full
unit suite still passes all 1,238 tests. The visible guest's existing 1:40 Local
Copy remained listed with its Save link after the restart.
