# 01: Search, enter, and original created date

**Read first:** `.scratch/dashboard-room-management/README.md` and
CONTEXT.md **Usage Dashboard**.

**Module:** start `src/lib/home/dashboard-rooms.js`. This ticket adds
only `filterRooms` and `formatCreatedAt`. No lock, no selection, no
delete. `UsageDashboardStats.svelte` calls those two functions; it does
not keep a second copy of the filter.

**What the host can do:** filter the loaded table by name or slug, open
a room that still exists, and read each row's original creation date.

`getUsageDashboard` already returns `createdAt`. Wire it. Do not fetch
again.

**Seams (one failing test, then the code that passes it):**

1. `filterRooms` — fixture rows, not the page. A substring of name
   matches. A substring of slug matches. `'POD'` matches `'Podcast'`.
   `''` and `'   '` return every row. `'zzz'` returns `[]`.
2. `formatCreatedAt(Date.UTC(2026, 0, 15, 14, 5))` is the literal
   `'2026-01-15 14:05 UTC'`.
3. The room name in the table is a link to `/rec/{slug}`. Assert the
   href. Playwright does the round trip.

**Blocked by:** none.

**Leaves for later:** row identity stays `slug`. No checkboxes, lock
status, or action menus. `filterRooms` returns the same room objects it
was given, so a later ticket can select by slug without a new filter.

**Status:** ready-for-agent

- [ ] Created date column is `formatCreatedAt(room.createdAt)`.
- [ ] Search uses `filterRooms`. Clearing it shows the full list.
- [ ] No matches shows "No rooms match". A dashboard with no rooms still
      shows "No rooms yet".
- [ ] Entering a row lands on `/rec/{slug}` and the existing password
      flow. No new auth.
- [ ] TDD on the three seams above.
- [ ] Coverage includes empty query, whitespace query, name hit, slug
      hit, and no hit.
- [ ] E2E: create two rooms whose names are not prefixed `E2E ` (so
      `HIDE_TEST_ROOMS_IN_DASHBOARD` does not hide them), search down to
      one, follow the link, assert `/rec/{slug}`, assert the UTC created
      date on the row. Search with no hits shows "No rooms match".
- [ ] Docs: CONTEXT.md **Usage Dashboard** gains one sentence: the
      per-room table can be filtered by name or slug, each row links to
      its room, and each row shows the room's original creation date in
      UTC.
