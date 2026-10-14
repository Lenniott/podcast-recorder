# Dashboard room management

Work the **frontier**: the lowest-numbered ticket whose blockers are done.
If you are told "work on the dashboard tickets", start at `issues/01` and
continue only after that ticket's **Definition of done** is fully checked.
One ticket at a time. Inside a ticket, one red → green slice at a time.
Do not batch several tickets, and do not write the ticket's tests in a
block before any implementation.

## What this line is

The **Usage Dashboard** (create-room page, past the site password) becomes
the place a host **finds, enters, unlocks, and destroys rooms**. Glossary:
CONTEXT.md **Usage Dashboard**, plus the terms each ticket is told to add.

**Delete is never automatic.** Age, empty occupancy, and guest lock do not
remove a room. The only complete remove is an explicit dashboard (or CLI)
delete, and that remove is the existing `deleteRoom`. **Guest lock** is
what time and recording inactivity do: guests cannot join; the room stays
listed; the **Host** (host-claim cookie from create, `getHostClaim`) can
still enter. Knowing the room password does not make someone the host.
**Unlock** lets guests in again without changing **created date**.

## Two modules, and delete stays where it is

Depth here means one small interface with the rules behind it. Do not
add a file per rule, and do not add a wrapper that only calls through.

**`src/lib/server/guest-admission.js`** — the only place that answers
"may this person enter?" and the only place that unlocks. Born in
ticket 02, deepened in 03 and 04. Room page load, the enter action, the
WebSocket join, and the dashboard all call it. They do not each keep a
copy of the rule.

Public interface, and only this. Later tickets add a function only when
the table below says so. Do not export the individual predicates
(`isTimeLocked`, `isInactivityLocked`, a clock setter, a last-access
reader).

```js
admit({ slug, isHost, clientId, now, env })
// → { admitted: true } | { admitted: false, reason: 'missing' | 'time' | 'inactivity' }

guestLockSummary({ slug, now, env })
// → { guestsLocked: boolean }

unlockGuests({ slugs, now })
// → { unlocked: string[], missing: string[] }
```

- `isHost` is the boolean from `getHostClaim`. Never a role string, display
  name, or "they knew the password."
- `clientId` is the browser's existing sessionStorage id. HTTP page load
  and the enter action do not have it; pass `null`. Inactivity is decided
  only when `clientId` is present (WebSocket `join`). Do not add a
  clientId cookie to close that gap.
- A new `clientId` is a different guest for the inactivity rule. Do not
  re-key the rule onto display name or the room session cookie.
- `admit` records last access only when it admits a guest **with** a
  `clientId`. A refusal does not refresh access and does not delete the
  room. Callers do not write access themselves.
- `guestLockSummary` is the dashboard row. It does not write.
- `unlockGuests` is the single-row and the bulk unlock. One slug is
  `unlockGuests({ slugs: [slug], now })`.

Storage this module owns. Callers do not write it.

- `rooms.guest_lock_at` (integer, null). Null means `created_at`. Unlock
  sets it to `now`. Nothing else writes it. `created_at` is insert-only.
- `guest_access(slug, client_id, accessed_at)`, ticket 04. Written only
  by `admit` on an admitted guest join, and cleared in effect by
  `unlockGuests` (treat every guest as accessed at `now`).

Thresholds are read inside the module from the injected `env` (same
shape as today's `room-lifetime.js`). Defaults in parentheses. The
dashboard does not edit them.

- `GUEST_LOCK_HOURS` (12) — ticket 03
- `GUEST_RECORDING_LOCK_MINUTES` (10) — ticket 04
- `GUEST_INACTIVITY_LOCK_HOURS` (2) — ticket 04

Ticket 02 retires `ROOM_MAX_AGE_HOURS`. Do not reuse that name for the
guest-lock threshold.

Tests for this module use the real sqlite harness (`DB_PATH=:memory:`,
same style as `tests/unit/db.test.js`) and the existing server-copy
fixtures. Inject `now` and `env`. Do not mock `db.js`. Do not assert
column names; a later `admit` / `guestLockSummary` / `getRoomBySlug`
shows whether the clock moved and whether `created_at` did not.

**`src/lib/home/dashboard-rooms.js`** — pure list behaviour for the
table. No I/O, no Svelte. Ticket 01 starts it; ticket 06 adds selection
to the same file.

```js
filterRooms(rooms, query)          // ticket 01
formatCreatedAt(createdAtMs)       // ticket 01 → 'YYYY-MM-DD HH:mm UTC'

toggleSlug(selected, slug)         // ticket 06
selectVisible(selected, visible)   // ticket 06
```

`selected` is an array of slugs. Order does not matter. No duplicates.
`filterRooms` is a case-insensitive substring on name or slug. Trim the
query; empty or whitespace shows every room. `selectVisible` **replaces**
the selection with the slugs of `visible`, so a row hidden by search
cannot stay selected. `toggleSlug` drops a slug that is already present
and adds one that is not.

**Delete** stays `deleteRoom` in `db.js`. No `deleteRoomFromDashboard`,
no batch twin. The page action loops `deleteRoom`. A return of `0` is a
missing slug: skip it, keep going, report it. Do not abort the rest.

`UsageDashboardStats.svelte` renders. Filter, selection, lock rules, and
delete do not live in the component as the source of truth.

## Locked product decisions

- Search is `filterRooms` over the already-loaded table. No extra server
  round-trip. No matches shows "No rooms match", which is not the
  "No rooms yet" empty dashboard.
- Enter is a link to the existing room URL. Password gate unchanged.
  Host enter works on a guest-locked room. Guest enter does not.
- Created date is `created_at` at insert, shown as UTC via
  `formatCreatedAt`, never rewritten on unlock.
- **Guest-lock clock** is `guest_lock_at`, starting null (read as
  `created_at`). Unlock sets it to now.
- **Prior to a recording**, guests are not time-locked. "A recording"
  means server-known audio for the room (what `listServerCopyFiles`
  already returns, partial uploads included). Local-only WAVs do not
  count.
- **Time lock:** once the room has any server-known audio, guests are
  locked when `now - guestLockClock > GUEST_LOCK_HOURS`. Compare with
  `>`, so a room created at `now` is not locked in the same millisecond.
  If the clock is already past the threshold when the first server copy
  appears, guests lock at that moment. This is room-level: HTTP load,
  enter POST, and WebSocket all call `admit`.
- **Guest refusal copy** is a locked message on `/rec/{slug}`. Do not
  redirect to `/?expired=1` and do not delete. One sentence for both
  rules, so ticket 04 does not invent a second banner: "This room is
  locked. Ask the host to unlock it." The host-claim holder does not
  see it.
- **Inactivity lock (per clientId):** that guest's server-known recording
  is longer than `GUEST_RECORDING_LOCK_MINUTES` **and** their effective
  last access is older than `GUEST_INACTIVITY_LOCK_HOURS`. Effective last
  access is the later of their `guest_access` row and the guest-lock
  clock. No access row means the clock alone, so a long recording with
  no recorded access is locked (including recordings that existed before
  this feature). Other guests are independent. Hosts are never locked by
  this rule. Decided on WebSocket `join` only, because that is when the
  server learns `clientId`. A refusal closes the socket with a reason the
  page shows as the same locked message. A successful join refreshes
  access, so an active guest is not locked by the window they are inside.
- **Unlock** moves the clock to now and makes effective access now for
  every guest. `created_at` unchanged. Allowed on locked and still-open
  rooms. Unknown slugs come back in `missing` and do not abort the
  others; the dashboard says which ones were missing and does not crash.
- **Delete** is complete removal (metadata, durable content, server
  copies) — today's `deleteRoom`. Confirm with a modal that names what
  will be destroyed. Local WAVs are not deleted. Research usage totals
  may remain. Cancel deletes nothing. After delete, `/rec/{slug}` is
  not-found, not a locked shell.
- Bulk actions call the same `unlockGuests` and the same `deleteRoom`
  loop. One confirm for the batch, naming that every selected room will
  be fully removed. Empty selection: the controls are disabled, and no
  request is sent. Select-all is `selectVisible` on the current filter.
- Occupancy (everyone left the WebSocket map) does not hide or lock the
  room.
- Time travel belongs to the `now` argument. Do not add a debug endpoint
  or query flag to forge clocks. Playwright covers clicks, copy, and
  navigation. Boundary times are unit tests through the interface above.

## Definition of done (every ticket)

1. **TDD.** Red → green on the seams named in the ticket. Those seams are
   already agreed; do not add tests at any other one. Tests call the
   public functions above, or assert user-visible text and navigation.
   Expected values are literals. Do not reimplement the rule inside the
   assertion, and do not assert that a mock was called.
2. **Coverage.** `npm run test:coverage`. New branches this ticket
   introduced are covered. Do not add tests whose only job is to raise
   a number.
3. **E2E.** The Playwright spec named in the ticket, using existing
   helpers (`createRoom`, `unlockIfNeeded`). A screenshot is not an e2e
   test. Do not weaken a unit-tested rule into a flaky sleep in
   Playwright.
4. **Docs.** The ticket names the CONTEXT.md sentences to add. Also
   update the repo README / AGENTS.md when the ticket says so.
5. **Shape.** Grow the module named in the ticket. Do not add a new
   module for a clause of a rule that already has a home. No drive-by
   refactors outside the slice.

## Checks before handing a ticket off

- `npx vitest run` (and `npm run check:standalone` if you touched anything
  `ws-rooms.js` imports)
- `npm run test:coverage`
- the Playwright spec this ticket names
- `npx svelte-kit sync && npx svelte-check` if you touched `.svelte` or
  page server files
