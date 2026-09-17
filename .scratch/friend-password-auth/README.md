# Friend password auth

Work the **frontier**: the lowest-numbered ticket whose blockers are done.
Start at `issues/01` and only move on once that ticket's checklist is fully
checked. Do not batch several tickets' implementations together.

## What this line is

Today there is exactly one password (`SITE_PASSWORD`) and one role: the
**Host**. This line adds a second, weaker role — the **Friend** — reached
with its own password, for self-hosters who want to hand a link+password to
people they trust without giving them the Host's create-room dashboard or
API-key-metered AI features.

## Locked product decisions

- **Friend password** is one shared secret (`FRIEND_PASSWORD`), exactly like
  today's `SITE_PASSWORD` — not a per-person credential. There is no way to
  tell two Friends apart or revoke one without changing the password for
  everyone. That's accepted, not a gap to fix here.
- A room created by a Friend is a **Friend room**. Research Assistant/AI is
  permanently off for a Friend room — no checkbox, no way to turn it on.
  Everything else about a Friend room (recording, notes, video, **Transcript**)
  works exactly like a Host room. Nothing in this line touches the Transcript
  path — it must keep working unchanged for Friend rooms.
- Friends cannot reach the Usage Dashboard or Custom Prompt management. That
  UI/data simply isn't reachable on a Friend session — not hidden-but-present.
- The Host is unaffected: same login, same dashboard, same room creation,
  same AI toggle on Host rooms. The Host can tell which rooms are
  Friend-created from the dashboard.
- **Friend room cap:** at most **3 active** (non-expired) Friend rooms at a
  time, counted globally — there's no per-Friend identity to count against,
  per the shared-password decision above. Host rooms never count toward this
  cap and are invisible to it.
- **Friend room expiry** is its own environment variable
  (`FRIEND_ROOM_MAX_AGE_HOURS`), independent of the Host's
  `ROOM_MAX_AGE_HOURS`. A Friend room's cap slot frees up when it expires.
- **Rooms full:** a Friend who already has 3 active Friend rooms and tries to
  create a 4th does not get a plain error — they land on a page listing the 3
  active Friend rooms with time remaining until each expires (soonest
  first), so they know when a slot will open. No such page exists or is
  needed for Host room creation.
- **Deep modules, thin interface:** each ticket below is expected to expose
  its behaviour behind one small, well-named function/module (e.g. "which
  role does this request have", "is the Friend cap full and when does it
  next open") rather than scattering role/cap checks as ad-hoc conditionals
  across routes. Callers use the interface; they don't re-derive the answer.
  TDD the interface first, from its exposed contract, not its internals.

## Out of scope here

- Per-Friend identity, individual revocation, or naming who created what.
- Any change to the unrelated `dashboard-room-management` epic (guest lock /
  Unlock) already sketched in this repo's `.scratch/` — that line is about
  Host rooms and hasn't shipped; this line does not depend on it or block it.
- Changing how Transcript, recording, notes, or video work for any role.
