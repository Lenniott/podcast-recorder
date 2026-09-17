# Dashboard room management

Work the **frontier**: the lowest-numbered ticket whose blockers are done.
If you are told "work on the dashboard tickets", start at `issues/01` and
continue only after that ticket's **Definition of done** is fully checked.
Do not batch several tickets' implementations and then sprinkle tests on
at the end.

## What this line is

The **Usage Dashboard** (create-room page, past the site password) becomes
the place a host **finds, enters, unlocks, and destroys rooms** — not just
a usage table. Glossary: CONTEXT.md **Usage Dashboard**.

**Delete is never automatic.** Age, empty occupancy, and guest lock do not
remove a room. The only complete remove is an explicit dashboard (or CLI)
delete. **Guest lock** is what time and recording inactivity do: guests
cannot join; the room stays listed; the **Host** (host-claim cookie from
create) can still enter. **Unlock** from the dashboard lets guests in
again without changing **created date**.

## Locked product decisions

- Search is a **name + slug** filter of the already-loaded table (no extra
  server round-trip).
- Enter is a link/button to the existing room URL; password gate unchanged.
  Host enter works on a guest-locked room. Guest enter does not.
- Created date is `created_at` at insert time, shown in the table, never
  rewritten on unlock.
- Thresholds are **environment variables** (defaults in parentheses):
  - guest time lock after **X hours** from the guest-lock clock
  - guest recording long enough to arm inactivity lock: **10 minutes**
  - guest inactivity after a long recording: **2 hours** without access
  Dashboard does not edit these values; it **shows lock state** and
  **Unlock**.
- **Guest-lock clock** starts at `created_at`. Unlock sets it to now.
  `created_at` never moves. Name the clock field in CONTEXT.md when ticket
  02/03 introduce it.
- **Prior to a recording**, guests are not time-locked. "A recording"
  means server-known audio for the room (server copy). Local-only WAVs
  cannot arm a lock — the server cannot see them.
- **Time lock:** once the room has server-known audio, guests are locked
  when the guest-lock clock is older than X. If that clock is already
  past X when the first server copy appears, guests lock at that moment.
- **Inactivity lock (per guest):** if **that guest's** server-known
  recording is longer than the recording threshold **and** they have not
  accessed **that room** (authenticated page load or WS join) within the
  inactivity window, **that guest** is locked. Other guests are decided
  independently. Hosts are never locked by this rule.
- **Unlock** (dashboard): guests may join again; clock resets to now;
  inactivity is cleared (treat as accessed now). Created date unchanged.
  Allowed on locked and still-open rooms (open = extend the clock).
- **Delete** is complete removal (metadata, durable content, server
  copies) — same meaning as today's `deleteRoom`. Confirm with a modal
  that names what will be destroyed. Local WAVs on people's computers
  are not deleted. Research usage totals may remain.
- Bulk actions: **delete** and **unlock** on the current selection.
- Occupancy (everyone left the WebSocket map) does **not** hide or lock
  the room.

## Definition of done (every ticket)

Copy is in each issue file. Do not mark a ticket ready to hand off until:

1. **TDD.** Red → green per seam listed in the ticket. Tests assert
   user-visible or public-module behaviour, not private helpers, CSS
   classes, or "the function called the mock". Expected values are
   literals / fixtures, not a reimplementation of the code under test.
2. **Coverage.** `npm run test:coverage` — new branches this ticket
   introduced are covered; overall coverage does not drop as a way of
   shipping. Do not add tests that only exist to inflate a number
   (rendering an empty wrapper, asserting a constant equals itself).
3. **E2E.** Playwright spec(s) named in the ticket, using existing
   helpers (`createRoom`, `unlockIfNeeded`, `HIDE_TEST_ROOMS_IN_DASHBOARD`
   conventions). Exercise the flow a host would, including the failure /
   empty / locked / delete-cancel path the ticket owns. A screenshot is
   not an e2e test.
4. **Docs.** Update CONTEXT.md (and README / AGENTS.md when lock vs
   delete changes) so a later agent does not rediscover behaviour from
   git blame. Ticket 02 owns retiring delete-on-age. Ticket 03 owns
   **Guest lock** vs **Host** vs **Unlock** glossary.
5. **Shape.** Small modules with one job; dashboard UI does not grow a
   god-component of search + bulk + delete + lock. Prefer extracting
   a named helper/module when a second ticket would otherwise copy logic.
   One definition of "may this guest join?" — the HTTP enter path, the
   room page load, and the WebSocket join must all call it. No drive-by
   refactors outside the slice.

## Checks to run before handing off a ticket

- `npx vitest run` (and `npm run check:standalone` if you touched anything
  `ws-rooms.js` imports)
- `npm run test:coverage`
- the Playwright spec(s) this ticket added or extended
- `npx svelte-kit sync && npx svelte-check` if you touched `.svelte` / page
  server files
