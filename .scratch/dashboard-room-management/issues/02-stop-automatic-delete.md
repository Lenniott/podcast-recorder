# 02: Stop automatic delete — rooms persist

**Read first:** ticket 01, CONTEXT.md **Usage Dashboard**, this folder's
README. Today `ROOM_MAX_AGE_HOURS` (default 12) **deletes** the room:
periodic cleanup and the room page load/actions all call `deleteRoom`.
That invariant is retired.

**What to build:** Age, occupancy, and visiting `/rec/{slug}` **must not
delete** a room. A room older than today's TTL stays **listed** on the
Usage Dashboard with its **original created date**. The **Host** can
still enter it (password + host claim as today). Guests are **not**
locked yet — that is ticket 03. This ticket only removes "time passed →
destroy everything."

This is the prefactor for guest lock and unlock. It needs a **guest-lock
clock separate from `created_at`**: existing rooms keep working (missing
field = `created_at` on migrate). `created_at` is display and history
only from this ticket forward. Ticket 03 will *read* the clock; ticket
03's unlock will *write* it. Leave a single obvious function that
updates only that field — do not wire a dashboard Unlock control yet.

**Where to look:** room lifetime helpers, `getActiveRoomBySlug` (today
deletes on age), room page load/actions that `deleteRoom` when aged,
expired-room cleanup / its scheduler, Usage Dashboard row shape. Many
unit tests currently assert that age removes files and rows — those
tests specify the **old** invariant and must be rewritten to the new
one, not deleted to "make green". Server-copy 410 for a **deleted** room
stays; there is no longer an "aged so we deleted it" path.

**TDD seams:**

1. Age helpers no longer imply destroy. `getActiveRoomBySlug` returns
   the row for an old room **without** deleting it (even when the old
   `cleanupExpired` flag would have).
2. Periodic cleanup no longer removes rooms (retire the job or make it
   a no-op — pick one; do not leave a zombie timer that still deletes).
3. Room page: an old room loads (host can authenticate); it does **not**
   redirect `/?expired=1` **and** delete. If you keep a query-flag
   redirect for anything, it must not be implemented by deleting.
4. Dashboard still lists the old room; created date is the original.
5. Guest-lock clock exists and defaults to `created_at`; nothing user-
   facing unlocks it in this ticket.

**Blocked by:** 01 — Search, enter, and original created date

**Hands off to ticket 03:** Guest refusal and dashboard Unlock are
**not** this ticket. Hosts and guests can both still join an old room
after this ships — that is an accepted intermediate. Ticket 03 closes
the guest path.

**Status:** ready-for-agent

- [ ] `created_at` is never written after insert; guest-lock clock lives
      on a separate field (name it in CONTEXT.md).
- [ ] A room past `ROOM_MAX_AGE_HOURS` appears on the dashboard; created
      date is still the original; server copies and durable content are
      still there.
- [ ] Visiting or POSTing that room does not delete it.
- [ ] Background cleanup does not delete rooms.
- [ ] Host can enter from the dashboard after the old TTL would have
      fired.
- [ ] Existing tests that encoded "age deletes" are updated to persist.
- [ ] TDD on the seams above. Do not test SQL column names as the
      behaviour; test through get-by-slug / HTTP / dashboard list.
- [ ] Coverage: legacy row with only `created_at`, migrated row with a
      distinct clock, "old but still in DB" paths.
- [ ] E2E: create a room, force the clock old (same mechanism unit tests
      use — no secret production backdoor), reload dashboard, row still
      present; opening it as host still works; dashboard still lists it
      afterwards.
- [ ] Docs: CONTEXT.md + AGENTS.md + README `ROOM_MAX_AGE_HOURS` /
      cleanup text: delete is explicit only. A new agent must not
      reintroduce delete-on-age. Mention that guest lock is ticket 03,
      not this one.
