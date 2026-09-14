# 04: Delete a room completely from the dashboard

**Read first:** this folder's README; existing `deleteRoom` meaning
(metadata + durable content + server copies). Ticket 01 for the table
to attach to. Independent of reactivate.

**What to build:** From a dashboard row, a host can **delete** that room
completely. The row disappears. The slug is gone: join is not-found, not
expired. Reactivate cannot bring it back. Confirm before destroying
(cannot undo).

Reuse the existing complete-delete path; do not invent a second "soft
delete". Dashboard is site-password gated; same gate as other home
actions.

**Where to look:** `deleteRoom` and its unit tests (already specify
complete removal). Home page actions. CLI `scripts/rooms.js` is out of
scope except do not regress what complete delete means.

**TDD seams:**

1. Home action: site-authed delete of a known slug; room gone from
   `getRoomBySlug` / dashboard list; unauthenticated cannot delete.
2. Confirm: the destructive control does not fire on a single misclick
   (dialog or equivalent). Test the behaviour, not a particular widget
   library.
3. After delete, usage **totals** may still include historical research
   usage for that slug (today usage outlives rooms — do not "fix" that
   unless you are asked). The **per-room table** must not keep a zombie
   row for a deleted room.

**Blocked by:** 01 — Search, enter, and original created date

**Hands off to ticket 05:** One-row delete only. Export/reuse one delete
path so bulk delete cannot skip server copies.

**Status:** ready-for-agent

- [ ] Delete removes the room completely (same as today's server delete).
- [ ] Dashboard table no longer shows that row; searching for its name
      does not find it.
- [ ] Visiting `/rec/{slug}` after delete is not-found, not a hollow
      expired shell.
- [ ] Confirmation required; cancel leaves the room intact.
- [ ] TDD on the seams above. Do not assert "SQL DELETE was invoked";
      assert the room cannot be loaded and files/content are gone.
- [ ] Coverage: happy delete, cancel, unknown slug, unauthenticated.
- [ ] E2E: create a room, see it on the dashboard, delete with confirm,
      gone from table; `/rec/{slug}` not-found path. Second test: open
      confirm, cancel, room still listed and enterable.
- [ ] Docs: CONTEXT.md — delete is the only way a room disappears;
      contrast ticket 02 expiry.
