# 03: Reactivate a room from the dashboard

**Read first:** ticket 02 (lifetime clock vs `created_at`), this folder's
README product locks.

**What to build:** From a dashboard row, a host can **reactivate** a room.
That sets the lifetime clock to now so `isRoomExpired` is false for a
fresh `ROOM_MAX_AGE_HOURS`. **Created date does not change.** After
reactivate, Enter works again with the existing password.

Allowed on both expired and still-active rooms (active = extend from now).

Site-password gate already protects the dashboard; reuse that. Do not
invent a second admin secret.

**Where to look:** ticket 02's lifetime-reset function; home page form
actions (Custom Prompt CRUD is the pattern for dashboard POSTs); Usage
Dashboard table from ticket 01.

**TDD seams:**

1. Lifetime-reset helper: given a slug, only the lifetime clock moves;
   `created_at` and slug/name/password stay put; unknown slug is a no-op
   or honest failure (pick one and test it).
2. Home action: site-authed POST reactivates; unauthenticated POST does
   not; expired room becomes active according to `isRoomExpired`.
3. Dashboard UI: control visible; after success the row status is active
   and created date is the same string as before.

**Blocked by:** 02 — Expired rooms stay until deleted

**Hands off to ticket 05:** One-row only. Ticket 05 will call the same
helper/action in a loop (or a batch API that reuses the helper). Do not
build checkboxes here.

**Status:** ready-for-agent

- [ ] Reactivate starts a new lifetime window; created date column is
      unchanged.
- [ ] After reactivate, the host can enter the room (e2e through password
      if needed).
- [ ] Reactivate of a missing slug does not crash the dashboard.
- [ ] Logic is not copy-pasted into the Svelte file — the clock reset
      lives next to the other room-lifetime functions.
- [ ] TDD on the seams above.
- [ ] Coverage: expired→active, already-active extend, unknown slug,
      unauthenticated reject.
- [ ] E2E: expire a room (same mechanism as ticket 02), confirm cannot
      enter, reactivate from dashboard, confirm can enter; created date
      text on the row is identical before and after.
- [ ] Docs: CONTEXT.md **Usage Dashboard** documents Reactivate vs
      created date vs expiry.
