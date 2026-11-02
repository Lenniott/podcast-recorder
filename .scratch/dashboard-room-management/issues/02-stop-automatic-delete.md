# 02: Stop automatic delete — rooms persist

**Read first:** ticket 01, the folder README, CONTEXT.md **Usage Dashboard**.

Today `ROOM_MAX_AGE_HOURS` (default 12) deletes the room. Page load, the
enter action, `getActiveRoomBySlug`, and `startExpiredRoomCleanup` all
do it. That is retired here. Guests are not locked yet.

**Module:** create `src/lib/server/guest-admission.js` and export `admit`
only.

- A slug with no row → `{ admitted: false, reason: 'missing' }`.
- A row that exists → `{ admitted: true }`, however old `created_at` is.
- `admit` reads `guest_lock_at` and treats null as `created_at`, but it
  does not refuse on age and it does not write the column.
- No `guestLockSummary`, no `unlockGuests`, no setter.

**Also in this ticket, and nowhere else:**

- Add `rooms.guest_lock_at` the same way `guest_ai_allowed` was added
  (ALTER, ignore duplicate column). Existing rows stay null.
- `getActiveRoomBySlug` returns the row whenever it exists. Remove the
  `cleanupExpired` argument. It must not call `deleteRoom`.
- Room page load and actions stop calling `isRoomExpired` / `deleteRoom`
  on age. A missing room is still not-found.
- Remove `cleanupExpiredRooms`, `expired-room-cleanup.js`, and the
  `startExpiredRoomCleanup()` call in `server.js`. Do not leave a timer
  that no longer deletes. Remove `ROOM_MAX_AGE_HOURS` from the repo
  README and the server log line.
- `deleteRoom` itself stays. Explicit delete is unchanged.

Rewrite tests that currently specify "age deletes". Do not delete them
to get green. Point them at the new behaviour: an old room is still
returned by `getRoomBySlug` / `listRooms`, and `admit` still admits.

**Seams:**

1. `admit` on a room whose `created_at` is years ago, with and without
   `guest_lock_at` set to something else, returns `{ admitted: true }`.
   `getRoomBySlug` still finds it. `created_at` is unchanged.
2. `admit` on an unknown slug returns `{ admitted: false, reason: 'missing' }`.
3. The old cleanup entry points are gone: nothing in `server.js` or the
   page server deletes a room for being old. A unit test that used to
   expect `cleanupExpiredRooms` to return 1 now expects the room to
   still be listed. Server copies and durable content are still there.
4. Room page load of an old room does not redirect `/?expired=1`.

**Blocked by:** 01.

**Leaves for ticket 03:** refusing guests, the dashboard lock label, and
`unlockGuests`. After this ticket, host and guest can both still join an
old room. That is accepted.

**Status:** ready-for-agent

- [ ] `created_at` is never written after insert. `guest_lock_at` is a
      separate nullable column.
- [ ] A room older than 12 hours is still listed, still has its server
      copies and durable content, and `admit` admits it.
- [ ] Visiting or POSTing that room does not delete it.
- [ ] No background cleanup deletes rooms.
- [ ] Host can open it from the dashboard.
- [ ] Tests that encoded "age deletes" now encode "age persists".
- [ ] TDD on the seams above, through `admit` / `getRoomBySlug` /
      `listRooms` / the page load. Not through SQL text.
- [ ] Coverage: legacy row (`guest_lock_at` null), row with a distinct
      `guest_lock_at`, unknown slug, old room still listed.
- [ ] E2E: create a room, it stays on the dashboard, the host can open
      it. Do not forge `created_at` from Playwright. Age is the unit seam.
- [ ] Docs: CONTEXT.md **Research Eval Log** replaces "Rooms still
      expire" with "Rooms stay until an explicit delete." CONTEXT.md
      **Usage Dashboard** says a room is not removed for being old.
      AGENTS.md gains one line: age does not delete a room; do not
      reintroduce `ROOM_MAX_AGE_HOURS` as a delete. Repo README drops
      `ROOM_MAX_AGE_HOURS`. Guest lock is ticket 03, say so in AGENTS.md
      in one clause so the next agent does not build it here.
