# 02: Expired rooms stay until deleted

**Read first:** ticket 01, CONTEXT.md **Usage Dashboard**,
`room-lifetime` / `ROOM_MAX_AGE_HOURS` (expiry is currently
`now - created_at`, and expiry **deletes** the room via cleanup and via
the room page load). README of this folder for the new invariant.

**What to build:** A room older than `ROOM_MAX_AGE_HOURS` is **expired
(unusable)** but **still listed** on the Usage Dashboard, with its
**original created date unchanged**. Joining `/rec/{slug}` still refuses
entry (expired banner / redirect) but **must not delete the room**.
Periodic cleanup **must not delete** expired rooms either.

This is the prefactor for reactivate. It requires a **lifetime clock
separate from `created_at`**: existing rooms should keep working (treat
missing/new field as `created_at` on migrate). `created_at` is display
and history only from this ticket forward.

**Where to look:** `isRoomExpired`, `getActiveRoomBySlug` (today deletes
on expiry), room page load/actions that `deleteRoom` when expired,
`cleanupExpiredRooms` / `startExpiredRoomCleanup`, Usage Dashboard row
shape. Many unit tests currently assert that expiry removes files and
rows — those tests are specifying the **old** invariant and must be
rewritten to the new one, not deleted to "make green".

**TDD seams:**

1. `isRoomExpired` uses the lifetime clock, not `created_at`.
2. `getActiveRoomBySlug` returns null for an expired room **without**
   deleting it (even when the old `cleanupExpired` flag would have).
3. `cleanupExpiredRooms` no longer removes rooms (or the function is
   retired and callers stop scheduling deletes — pick one, don't leave a
   zombie job that still deletes).
4. Dashboard row includes an honest **expired / active** flag derived
   from the same `isRoomExpired` helper the join path uses — one
   definition of expired, not two.
5. Room page: expired → redirect `/?expired=1` **and** `getRoomBySlug`
   still finds the row afterwards.

**Blocked by:** 01 — Search, enter, and original created date

**Hands off to ticket 03:** Reactivate is **not** this ticket. Leave a
single, obvious place to reset the lifetime clock (a function that
updates only that field). Ticket 03 will call it from a dashboard action.

**Status:** ready-for-agent

- [ ] `created_at` is never written after insert; lifetime lives on a
      separate field (name it in CONTEXT.md).
- [ ] Expired rooms appear in the dashboard table with a status the host
      can see; created date is still the original.
- [ ] Visiting or POSTing an expired room does not delete it.
- [ ] Background cleanup does not delete expired rooms.
- [ ] Enter from the dashboard on an **expired** row does not pretend the
      room is joinable (disable the enter control, or send them through
      the existing expired redirect — either is fine if it is honest).
- [ ] Existing tests that encoded "expiry deletes" are updated to the new
      invariant; server-copy 410 behaviour for **expired** rooms can stay
      (unusable), but must not be implemented by deleting the room.
- [ ] TDD on the seams above. Do not test SQL column names as the
      behaviour; test expiry through `isRoomExpired` / get-active / HTTP.
- [ ] Coverage: both clocks (legacy row with only `created_at`, migrated
      row with a distinct lifetime) and the "expired but still in DB"
      paths.
- [ ] E2E: create a room, force it expired (lifetime in the past via the
      same mechanism unit tests use — or a test-only hook already used
      elsewhere; do not invent a secret production backdoor), reload
      dashboard, row still present and marked expired; opening it does
      not join; dashboard still lists it after that attempt.
- [ ] Docs: CONTEXT.md + AGENTS.md + README `ROOM_MAX_AGE_HOURS` text:
      expiry = unusable, delete = explicit. A new agent must not
      reintroduce delete-on-expiry.
