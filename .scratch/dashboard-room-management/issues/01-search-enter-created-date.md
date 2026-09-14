# 01: Search, enter, and original created date

**Read first:** `.scratch/dashboard-room-management/README.md` (product
locks + definition of done) and CONTEXT.md **Usage Dashboard**.

**What to build:** From the Usage Dashboard table, a host can **filter
rooms by name or slug**, **open a still-active room**, and see each row's
**original creation date**. No delete, no reactivate, no change to expiry
semantics in this ticket.

The aggregation payload already carries `createdAt`; the table just does
not show it and room names are plain text. Search is client-side over
that loaded list.

**Where to look:** Usage Dashboard stats table and `getUsageDashboard`.
Home Playwright helpers already create rooms and unlock the site gate.
Existing e2e rooms are named `E2E …` and may be hidden from the table when
`HIDE_TEST_ROOMS_IN_DASHBOARD` is on — specs for this line must still be
able to **see the rooms they create** (name them so they show, or drive
the flag in the test env the same way other dashboard tests would need).

**TDD seams (write the failing test first, then the code):**

1. Dashboard payload: every room row includes a numeric `createdAt` that
   matches the room's insert time (already true — lock it with an
   assertion so later tickets cannot "fix" expiry by rewriting it).
2. Table: given a fixture list, filtering by a substring of **name** or
   **slug** shows only matches; empty query shows all; no matches shows
   an empty/honest state, not a broken table. Extract the filter so it
   is unit-tested without mounting the whole page.
3. Enter: the room name (or a dedicated control) is a real navigation to
   that room's URL. Prefer a unit/component assertion on the href, then
   e2e for the round trip.

**Blocked by:** None (can start immediately).

**Hands off to later tickets:** Keep row identity as `slug`. Do not cram
checkboxes, status, or action menus into this ticket. If the table
component starts absorbing search + formatting, split formatting/filter
into a small module now — tickets 04–05 will attach actions to the same
rows.

**Status:** ready-for-agent

- [ ] Created date column shows the original insert time (human-readable,
      unambiguous), sourced from `createdAt` / `created_at`, not "last
      seen" or "last activity".
- [ ] Search filters the table by room name and slug; clearing it restores
      the full list.
- [ ] An active room is enterable from its row and lands on the existing
      room password/session flow (no new auth).
- [ ] Filter logic lives in a tested module, not an anonymous inline in
      the Svelte file.
- [ ] TDD: red → green on the seams above; no tests of CSS class names or
      private function names.
- [ ] Coverage: new filter/empty-query branches covered; `npm run test:coverage`
      does not drop as a shipping tactic.
- [ ] E2E: Playwright — create at least two rooms, search down to one,
      click enter, assert URL `/rec/{slug}`; assert created date is visible
      on the row. Also: search with no hits shows the empty state.
- [ ] Docs: CONTEXT.md **Usage Dashboard** mentions search, enter, and
      created date on the per-room table. README of this scratch folder
      stays the source of locked decisions.
