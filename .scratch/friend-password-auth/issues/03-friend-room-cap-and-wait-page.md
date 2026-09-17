# 03 — Friend room cap (3 active), own expiry clock, "rooms full" wait page

**Read first:** this folder's README (locked decisions), ticket 02's Friend
room flag. Glossary to add to CONTEXT.md: **Friend room cap**, **Rooms
full** (page).

**What to build:** Friend rooms expire against their own
`FRIEND_ROOM_MAX_AGE_HOURS` clock — completely independent of the Host's
existing `ROOM_MAX_AGE_HOURS`. At most 3 Friend rooms may be active
(non-expired) at once, counted globally across all Friends (there's no
per-Friend identity — see README). A Friend session that already has 3
active Friend rooms and submits the create-room form does not get a plain
validation error: they land on a **Rooms full** page listing those 3 active
Friend rooms with time remaining until each expires, soonest first. As soon
as one expires, a Friend can create a new one again — no manual unlock step,
no Host action required.

Host room creation, Host room expiry, and the Host's own
`ROOM_MAX_AGE_HOURS` are untouched by this ticket — the cap and its wait
page only ever apply to the Friend role and Friend rooms.

**Where to look:** `room-lifetime.js`'s `isRoomExpired`/`getRoomMaxAgeHours`
(a Friend room needs the same shape of function reading a different env
var, keyed off the Friend-room flag from ticket 02); `db.js`'s
`listRooms`/`getActiveRoomBySlug` (counting active Friend rooms); the
create-room action in `+page.server.js` (where the cap check has to run
before a room is actually created); wherever expired rooms currently get
cleaned up (`getActiveRoomBySlug`'s `cleanupExpired`).

**TDD seams:**

1. Expiry: a Friend room past `FRIEND_ROOM_MAX_AGE_HOURS` is expired
   regardless of `ROOM_MAX_AGE_HOURS`'s value; a Host room past
   `ROOM_MAX_AGE_HOURS` is expired regardless of
   `FRIEND_ROOM_MAX_AGE_HOURS`'s value. One expiry function, parameterized
   by room kind — not two near-duplicate copies.
2. Cap check: a single function answers "is the Friend cap full right now,
   and if so, what are the 3 active rooms and their remaining time" — the
   create action and the Rooms-full page both call *that*, neither
   recomputes it.
3. Boundary: exactly 3 active Friend rooms blocks a 4th; 2 active does not;
   a room that expires between the count and the create attempt doesn't
   wrongly block (re-check, don't trust a stale count).
4. Time-remaining values in the Rooms-full page are correct and ordered
   soonest-first; they use the Friend clock, not the Host one.

**Blocked by:** 02 — Friend login, AI-off rooms, dashboard block.

**Status:** ready-for-agent

- [ ] `FRIEND_ROOM_MAX_AGE_HOURS` documented (README/CONTEXT.md/
      `.env.example`), independent default from `ROOM_MAX_AGE_HOURS`.
- [ ] A Friend room expires on its own clock; a Host room's expiry is
      unaffected by the new env var.
- [ ] With 3 active Friend rooms, a Friend's create attempt is redirected to
      the Rooms-full page instead of creating a room or showing a bare
      validation error.
- [ ] Rooms-full page lists exactly the 3 active Friend rooms with correct,
      soonest-first time-remaining values.
- [ ] Once any of the 3 expires, a Friend can create a new room without any
      manual/Host intervention.
- [ ] Host room creation is never subject to the cap or the Rooms-full page.
- [ ] One cap-check interface and one parameterized expiry function; no
      duplicated "is it a Friend room past its limit" logic across routes.
- [ ] TDD on the seams above, including the exactly-3 boundary and the
      stale-count race.
- [ ] Coverage: 0/1/2/3 active Friend rooms × create attempt; Friend vs Host
      expiry independence; Rooms-full ordering with mixed expiry times.
- [ ] E2E: as Friend, create 3 rooms, confirm a 4th attempt lands on
      Rooms-full with correct countdowns; force/await one to expire; confirm
      a new Friend room can then be created.
