# 03: Guest time lock and dashboard Unlock

**Read first:** ticket 02 (persist + guest-lock clock vs `created_at`),
this folder's README product locks. Glossary to add: **Guest lock**,
**Unlock**.

**What to build:** Once a room has **server-known audio**, **guests**
cannot join if the guest-lock clock is older than **X hours** (env,
same injectable-env shape as today's room max-age). The **Host** can
still enter. The dashboard row shows that guests are locked. From that
row the host can **Unlock**: clock = now, created date unchanged,
guests can join again with the existing password.

**Prior to a recording** (no server copy for the room yet): guests stay
unlocked even if the clock is older than X.

Unlock is allowed on locked and still-open rooms (open = extend the
clock from now). Site-password gate already protects the dashboard.

X is an environment variable, not a form field. Do not implement the
per-guest recording/inactivity rule here (ticket 04). Do leave the join
decision in **one** helper both HTTP and WebSocket call, so ticket 04
can add a clause without a second gate.

**Where to look:** ticket 02's clock field and reset function; room page
load/enter and WS join (`getActiveRoomBySlug` is the wrong name if it
still means "exists"); host-claim vs guest; Usage Dashboard table from
ticket 01; home page form actions (Custom Prompt CRUD is the POST
pattern).

**TDD seams:**

1. Join helper: no server audio → guest allowed regardless of clock;
   server audio + clock older than X → guest refused, host allowed;
   server audio + clock fresh → both allowed. Same helper for page
   load, enter POST, and WS connect.
2. Guest refusal is honest (existing expired-style banner/redirect or a
   dedicated locked message — pick one, not a silent drop, **not**
   delete). Host with claim still reaches the room.
3. Unlock helper: only the guest-lock clock moves; `created_at` and
   slug/name/password stay put; unknown slug is a no-op or honest
   failure (pick one and test it).
4. Home action: site-authed POST unlocks; unauthenticated POST does
   not; after unlock the join helper allows guests.
5. Dashboard: lock status visible; Unlock control; after success the
   status is open-to-guests and created date string is unchanged.

**Blocked by:** 02 — Stop automatic delete — rooms persist

**Hands off to ticket 04:** Per-guest inactivity after a long recording
is not this ticket. Ticket 04 extends the same join helper.

**Hands off to ticket 06:** One-row Unlock only. No checkboxes.

**Status:** ready-for-agent

- [ ] Env var for X documented (name it in CONTEXT.md / README); default
      behaviour is specified with a literal in tests, not by re-parsing
      env inside the assertion.
- [ ] Guests can join a room with no server copy even when the clock is
      older than X.
- [ ] Guests cannot join a room that has server-known audio and a clock
      older than X; the room is still listed; content and audio remain.
- [ ] Host can enter a guest-locked room from the dashboard.
- [ ] Unlock resets the clock; created date column is unchanged; guests
      can enter again (e2e through password).
- [ ] Unlock of a missing slug does not crash the dashboard.
- [ ] One join helper; WS join cannot bypass HTTP lock.
- [ ] TDD on the seams above.
- [ ] Coverage: no-audio / has-audio × clock fresh / clock old × host /
      guest; unauthenticated unlock reject.
- [ ] E2E: create room, still no recording, force clock old, guest can
      still enter; add/force a server-known recording, guest cannot,
      host can, dashboard shows locked; Unlock; guest can enter;
      created date text identical before and after.
- [ ] Docs: CONTEXT.md **Usage Dashboard** + **Guest lock** / **Unlock**;
      AGENTS.md must not describe age as delete or as locking the host.
