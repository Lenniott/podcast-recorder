# Dashboard room management

Work the **frontier**: the lowest-numbered ticket whose blockers are done.
If you are told "work on the dashboard tickets", start at `issues/01` and
continue only after that ticket's **Definition of done** is fully checked.
Do not batch several tickets' implementations and then sprinkle tests on
at the end.

## What this line is

The **Usage Dashboard** (create-room page, past the site password) becomes
the place a host **finds, enters, extends, and destroys rooms** — not just
a usage table. Glossary: CONTEXT.md **Usage Dashboard**. Rooms still expire
after `ROOM_MAX_AGE_HOURS`; expiry means **unusable**, not **deleted**.
Deletion is an explicit dashboard (or CLI) action. Reactivate starts a new
lifetime window; **created date never moves**.

## Locked product decisions

- Search is a **name + slug** filter of the already-loaded table (no extra
  server round-trip).
- Enter is a link/button to the existing room URL; password gate unchanged.
- Created date is `created_at` at insert time, shown in the table, never
  rewritten on reactivate.
- Expired rooms **stay listed** until deleted.
- Reactivate resets the **lifetime clock**, not `created_at`. Live rooms
  may be reactivated too (extends from now).
- Delete is complete removal (metadata, durable content, server copies) —
  same meaning as today's `deleteRoom`.
- Bulk actions: **delete** and **reactivate** on the current selection.

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
   empty / expired path the ticket owns. A screenshot is not an e2e test.
4. **Docs.** Update CONTEXT.md (and README / AGENTS.md when the lifetime
   invariant changes) so a later agent does not rediscover behaviour from
   git blame. Ticket 02 owns the expiry-vs-delete glossary shift.
5. **Shape.** Small modules with one job; dashboard UI does not grow a
   god-component of search + bulk + delete + lifetime. Prefer extracting
   a named helper/module when a second ticket would otherwise copy logic.
   No drive-by refactors outside the slice.

## Checks to run before handing off a ticket

- `npx vitest run` (and `npm run check:standalone` if you touched anything
  `ws-rooms.js` imports)
- `npm run test:coverage`
- the Playwright spec(s) this ticket added or extended
- `npx svelte-kit sync && npx svelte-check` if you touched `.svelte` / page
  server files
