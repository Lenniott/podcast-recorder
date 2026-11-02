# 03: Guest time lock and dashboard Unlock

**Read first:** ticket 02 (`admit`, `guest_lock_at`), the folder README.

**Module:** deepen `guest-admission.js`. Add `guestLockSummary` and
`unlockGuests`. Extend `admit`. Do not add another join gate.

`GUEST_LOCK_HOURS` defaults to 12, read from the injected `env`. Tests
pass the number in `env`. The assertion's expected instant is a literal
you computed by hand (`created + 12h + 1ms`), not a second copy of the
parser.

**`admit` after this ticket:**

- No row → `{ admitted: false, reason: 'missing' }`.
- `isHost: true` → `{ admitted: true }` even when guests are time-locked.
- No server-known audio → `{ admitted: true }` for a guest, however old
  the clock is.
- Server-known audio and `now - clock > GUEST_LOCK_HOURS` →
  `{ admitted: false, reason: 'time' }`. Clock is `guest_lock_at` if set,
  otherwise `created_at`.
- Server-known audio and clock still inside the window → admitted.
- `clientId` is ignored for the decision in this ticket. Do not record
  access yet.

Page load, the enter action, and the WebSocket connection all call
`admit` before they let a guest in. A `time` refusal on HTTP stays on
`/rec/{slug}` and shows: "This room is locked. Ask the host to unlock
it." It does not delete and does not redirect to `/?expired=1`. A `time`
refusal on the socket closes it; the page shows that same sentence.
The host-claim holder never sees it.

**`unlockGuests({ slugs, now })`:**

- Sets `guest_lock_at` to `now` for each slug that exists.
- Does not change `created_at`, slug, name, or password.
- Unknown slugs are listed in `missing`. The others still unlock.
- Allowed when the room is locked and when it is open.
- Site-password POST on the create-room page is the only caller. An
  unauthenticated POST does not unlock.

**`guestLockSummary`:** `{ guestsLocked: true }` exactly when a guest
`admit` would return `reason: 'time'`. Otherwise `{ guestsLocked: false }`.
The dashboard row shows "Guests locked" or "Open to guests" from that
boolean, plus an Unlock control.

**Seams:**

1. `admit` grid, one test at a time: no audio × old clock → admitted;
   audio × old clock × guest → `time`; audio × old clock × host →
   admitted; audio × fresh clock × guest → admitted; missing slug →
   `missing`.
2. After a `time` refusal, `getRoomBySlug` still returns the room and
   its content is still there.
3. `unlockGuests` then a guest `admit` is admitted, and `created_at` is
   the same number as before the call. A missing slug is in `missing`
   and does not throw.
4. Home action: site-authed POST unlocks; unauthenticated POST leaves
   the clock where it was.
5. Dashboard label follows `guestLockSummary`. After unlock the label is
   "Open to guests" and the created-date text is unchanged.

**Blocked by:** 02.

**Leaves for ticket 04:** per-guest inactivity, inside this same `admit`
and `guestLockSummary`. No checkboxes (ticket 06).

**Status:** ready-for-agent

- [ ] `GUEST_LOCK_HOURS` documented in the repo README. Default 12.
- [ ] Guests join a room with no server copy even when the clock is old.
- [ ] Guests cannot join a room that has server-known audio and an old
      clock. The room, its content, and its audio remain.
- [ ] Host-claim holder enters that room from the dashboard. Password
      without the host-claim cookie does not bypass the lock.
- [ ] Unlock resets the clock. Created date text is unchanged. Guests
      can enter again.
- [ ] Unlock of a missing slug does not crash the dashboard; the page
      says it was missing.
- [ ] HTTP and WebSocket both call `admit`. The socket cannot bypass a
      `time` refusal.
- [ ] TDD on the seams above.
- [ ] Coverage: the admit grid, unauthenticated unlock, missing slug,
      unlock of an already-open room.
- [ ] E2E: create a room, it shows "Open to guests", Unlock succeeds and
      the created-date text is identical. Guest lock *refusal* is the
      unit seam (injected `now`). Do not add a clock-forging endpoint.
      The locked sentence is covered by a component or page test that
      renders the `time` refusal, plus the e2e of the unlock control.
- [ ] Docs: add CONTEXT.md entries, glossary only:
      - **Guest lock** — guests cannot join; the room stays listed; the
        host-claim holder can still enter. Not delete.
      - **Unlock** — guests may join again; the original creation date
        does not change.
      - **Guest-lock clock** — starts at creation; Unlock moves it to
        now; the creation date does not move.
      AGENTS.md: age is not delete and does not lock the host. Guest
      lock is this rule, not a second delete.
