---
name: Clear stay-quiet overlay
overview: "The e2e failures are the full-screen “Stay quiet” card: tests read it as only the turn sentence, and it covers Stop and the participant list. After the guest finishes their check, that card must come down and stay down."
todos:
  - id: sticky-passed
    content: Keep Check Turn at passed so a late host/guest presence cannot bring the waiting card back
    status: pending
  - id: testid-sentence
    content: Point check-quiet at the turn sentence so the existing e2e text assertion matches the card
    status: pending
  - id: e2e-callers
    content: Finish both checks before clicking Stop or the participant list; retry the join save click
    status: pending
isProject: false
---

# Clear the stay-quiet screen after both checks

The white card in the middle (“Stay quiet for a moment”) is the waiting screen. It covers the whole room, including Stop. The small line in the top bar is the same sentence again.

Four failures in that run are this card:

- [tests/playwright/check_turn.spec.js](tests/playwright/check_turn.spec.js) and [tests/playwright/synced_recording_session.spec.js](tests/playwright/synced_recording_session.spec.js) expect the waiting screen’s text to be only `It's the host's turn, please stay quiet.` The card’s text is that sentence plus `Recording` and `Stay quiet for a moment`, so the assertion fails before the test ever checks that the card goes away.
- [tests/playwright/recording_status.spec.js](tests/playwright/recording_status.spec.js) and [tests/playwright/voice_capture.spec.js](tests/playwright/voice_capture.spec.js) then try to click the participant list or Stop while the other person is still on their mic check. The card sits on top of those controls (`z-index: 1000` in [src/lib/recording/RecordingCheckModal.svelte](src/lib/recording/RecordingCheckModal.svelte)), so the click never lands.

Your sequence is the real bug underneath: host starts, guest waits, host finishes, guest checks, host waits, guest finishes, host is still waiting. Once the turn is `passed`, the host’s card has to unmount. A later presence that still says `guest` must not put it back. Today [applyRemote](src/lib/recording/recording-check.js) will accept that late `guest` and move the turn backwards. A second `passed` then does nothing, because `emitPassed` returns early once it has already fired, and the card stays up. Stop is behind the card, so the host cannot click their way out.

```167:180:src/lib/recording/recording-check.js
  function applyRemote(nextTurn) {
    if (!isCheckTurn(nextTurn)) return
    // ...
    if (nextTurn === CHECK_TURN.passed) {
      emitPassed()
      return
    }
    turn = nextTurn
  }
```

## Behavior

- While it is the other person’s check, the waiting card stays. That part is the check-turn design.
- When the guest confirms, the room’s turn becomes `passed`, the host’s card unmounts, and the top-bar line goes with it.
- A presence that arrives after `passed` with `host` or `guest` does not reopen the card. `idle` (stop / reset) still clears the sequence, as it does now.

## Code

- In `applyRemote`, once this peer has passed, ignore a later `host` or `guest`. If a `passed` arrives and the turn had already moved backwards, set the turn back to `passed` and clear the waiting role.
- [syncCheckTurnUi](src/routes/rec/[slug]/+page.svelte) already sets `stayQuietRole` from that turn. No second flag.
- Move `data-testid="check-quiet"` onto the sentence paragraph in the card (the `check-hint`), so [expectCheckQuiet](tests/playwright/helpers.js) keeps matching the sentence alone. The top-bar line in [RoomPresenceTable.svelte](src/lib/room/RoomPresenceTable.svelte) stays as it is.

## Tests

- Unit: after `applyRemote('passed')`, `applyRemote('guest')` leaves the turn `passed` and `stayQuietRole` null for the host. A `passed` that arrives while the turn is wrongly `guest` and `emittedPassed` is already true still ends on `passed`.
- E2E: [check_turn.spec.js](tests/playwright/check_turn.spec.js) already expects both `check-quiet` nodes gone after the guest confirms. That assertion is the proof the host is unblocked. It never ran this time because the text check failed first.
- [recording_status.spec.js](tests/playwright/recording_status.spec.js): pass the host check, then the guest check, then open the participant list. Skip on the host’s own modal currently counts as “host done” and immediately raises the host’s waiting card.
- [voice_capture.spec.js](tests/playwright/voice_capture.spec.js): pass the guest’s check before `stopAsHost`, so Stop is clickable.
- The three flakes (`Continue to room` missing after `Choose save location` on rejoin) are a separate join race in [completeJoinIfNeeded](tests/playwright/helpers.js). Retry the save click until the mic step or the room is visible, instead of one click and a 15s wait.
