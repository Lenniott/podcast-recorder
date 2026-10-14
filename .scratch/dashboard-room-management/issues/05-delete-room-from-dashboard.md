# 05: Delete a room completely from the dashboard

**Read first:** the folder README. `deleteRoom` is already the complete
remove (metadata, durable content, server copies). This ticket gives the
dashboard a way to call it. Independent of guest lock except that the
table from ticket 01 is where the control sits. Do not wait for ticket
04. Blocker is 01 only.

**Module:** none new. The page action calls `deleteRoom`. Do not wrap it.

**What the host can do:** from one row, delete that room. A modal names
what will be destroyed, in user-visible text:

- server audio (server copies)
- research entries and cards in the room
- tab content (notes and related tab state)
- transcript
- annotations
- the room itself (name, slug, password)

The modal also says local recordings on each person's computer are not
deleted. Confirm destroys. Cancel destroys nothing. Research usage
totals may still include the slug. The per-room table must not keep the
row.

The control does not fire on the first click. Site password already
gates the dashboard. An unauthenticated POST does not delete.

**Seams:**

1. Site-authed delete of a known slug: `getRoomBySlug` is null, the
   dashboard list no longer contains it, server copies and durable
   content are gone. Assert through those reads, not "DELETE ran".
2. Unauthenticated POST: the room is still there.
3. Unknown slug: no throw. The dashboard still renders.
4. Cancel: the room is still listed and still enterable. Test the
   behaviour (confirm is a second step), not a widget library.
5. The modal text contains the categories above. A literal string
   assertion, not a CSS class.

**Blocked by:** 01.

**Leaves for ticket 06:** one row only. The action's body should be a
straight call the bulk ticket can loop, not a one-off that forgets
server copies.

**Status:** ready-for-agent

- [ ] Delete removes the room the way `deleteRoom` already does.
- [ ] The row is gone. Searching its name does not find it.
- [ ] `/rec/{slug}` is not-found, not a locked or expired shell.
- [ ] Modal lists server audio, research in the room, tab content,
      transcript, annotations, the room itself, and that local WAVs
      remain. Cancel leaves the room.
- [ ] TDD on the seams above.
- [ ] Coverage: delete, cancel, unknown slug, unauthenticated.
- [ ] E2E: create a room, open the modal, assert the warning text,
      confirm, row gone, `/rec/{slug}` not found. Second run: open,
      cancel, row still listed and the enter link still works.
- [ ] Docs: CONTEXT.md **Usage Dashboard** says a room disappears only
      by this explicit delete (or the existing CLI delete), and that
      guest lock leaves the room listed.
