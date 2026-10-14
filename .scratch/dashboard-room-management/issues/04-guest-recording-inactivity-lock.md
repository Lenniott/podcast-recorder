# 04: Guest lock after a long recording and inactivity

**Read first:** ticket 03, the folder README (inactivity, effective last
access, the shared locked sentence).

**Module:** the same `guest-admission.js`. No new export. Inactivity is
another way `admit` returns `admitted: false` and another way
`guestLockSummary` returns `guestsLocked: true`.

`GUEST_RECORDING_LOCK_MINUTES` defaults to 10.
`GUEST_INACTIVITY_LOCK_HOURS` defaults to 2. Tests pass them on `env`
and use hand-computed literals (`10 * 60 * 1000`, `2 * 60 * 60 * 1000`).

Duration is that `clientId`'s rows from `listServerCopyFiles`, summed the
same way the dashboard already turns WAV bytes into seconds
(`(byteSize - 44) / (sampleRate * 2)`). Partial copies count. A local-only
WAV does not exist on that list, so it cannot arm the lock. Do not lift
the dashboard's total-seconds helper into a shared utility for this.

**`admit` additions, guest with a `clientId`:**

- Recording longer than the threshold and effective last access older
  than the inactivity window → `{ admitted: false, reason: 'inactivity' }`.
  Effective last access is the later of the `guest_access` row and the
  guest-lock clock. No row: the clock alone. A long recording and no
  access row is locked.
- Same guest, effective access inside the window → the time-lock rule
  from ticket 03 still applies; inactivity does not refuse.
- Recording shorter than the threshold, access stale → admitted (time
  lock permitting).
- `isHost: true`, long recording, stale access → admitted.
- A second guest in the same room is judged on their own `clientId`.
- `clientId: null` (HTTP) does not apply this rule. Time lock still does.
- When the result is `admitted: true` and `clientId` is set and
  `isHost` is false, write `guest_access` to `now`. A refusal writes
  nothing. Observe the write by calling `admit` again at a later `now`.
  Do not export a getter.

WebSocket `join` calls `admit` with the `clientId` from the join message
and the host-claim boolean already on the connection. An `inactivity`
refusal closes the socket. The page shows the same sentence as ticket 03:
"This room is locked. Ask the host to unlock it."

**`unlockGuests`:** after it runs, a guest who was inactivity-locked is
admitted (the clock move makes effective access `now`). No separate
clear function.

**`guestLockSummary`:** `guestsLocked: true` when the time lock applies
**or** any `clientId` with a long enough server copy is inactivity-locked.
The row stays "Guests locked" / "Open to guests". No per-guest roster.

**Seams:**

1. Long recording, no access row, `now` well past the clock →
   `inactivity`. Then `unlockGuests` at that `now`, then `admit` →
   admitted.
2. Long recording, access 1ms inside the window → not an inactivity
   refusal. Access 1ms outside → `inactivity`.
3. Recording 1ms under the threshold, access ancient → admitted.
4. Host with a long recording and ancient access → admitted.
5. Two client ids in one room: only the one that meets both conditions
   is refused.
6. An admitted guest join at `T` is still admitted at `T + window`.
   The same guest at `T + window + 1ms`, without another successful
   admit in between, is refused. Proves the write, without a getter.
7. `guestLockSummary` is locked when one guest is inactivity-locked and
   the time lock is not. It is open when the only long recording belongs
   to nobody who is stale.

**Blocked by:** 03.

**Leaves:** bulk actions (06). Do not change `deleteRoom`.

**Status:** ready-for-agent

- [ ] Both env vars documented in the repo README with their defaults.
- [ ] A guest with a long server copy and stale access cannot join. The
      room remains. The host can enter.
- [ ] A short or missing server copy does not inactivity-lock.
- [ ] Two guests: only the one who meets both conditions is refused.
- [ ] Unlock clears it, through `admit` afterwards.
- [ ] A successful join refreshes access. A refused join does not.
- [ ] HTTP `admit` without `clientId` does not apply inactivity. The
      socket join cannot skip `admit`.
- [ ] TDD on the seams above.
- [ ] Coverage: both boundaries, host exemption, unlock, missing access
      row, second guest.
- [ ] E2E is not a stand-in for the clock. Playwright: a room the unit
      tests would call open still shows "Open to guests", and Unlock
      still leaves the created date unchanged. The refusal grid is the
      unit seam.
- [ ] Docs: CONTEXT.md **Guest lock** lists both rules and says the
      inactivity rule is per browser `clientId` plus that guest's server
      copy, not per display name. Say that a long server copy with no
      recorded access is locked until Unlock.
