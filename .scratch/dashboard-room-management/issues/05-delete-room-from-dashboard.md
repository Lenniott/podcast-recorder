# 05: Delete a room completely from the dashboard

**Read first:** this folder's README; existing `deleteRoom` meaning
(metadata, durable content, server copies). Ticket 01 for the table to
attach to. Independent of guest lock / unlock.

**What to build:** From a dashboard **row**, a host can **delete** that
room completely. The row disappears. The slug is gone: join is not-found,
not a locked shell. Unlock cannot bring it back. Confirm with a **modal
that names what will be destroyed** (cannot undo):

- server audio (server copies)
- Research Assistant entries / Cards in the room
- tab content (notes and related tab state)
- transcript
- annotations
- the room itself (name, slug, password)

The modal must also say **local recordings on each person's computer are
not deleted.** Research usage **totals** may still include that slug
(today usage outlives rooms — do not "fix" that unless asked). The
per-room table must not keep a zombie row.

Reuse the existing complete-delete path; do not invent a second "soft
delete." Dashboard is site-password gated.

**Where to look:** `deleteRoom` and its unit tests (already specify
complete removal). Home page actions. CLI room-delete is out of scope
except do not regress what complete delete means.

**TDD seams:**

1. Home action: site-authed delete of a known slug; room gone from
   get-by-slug / dashboard list; unauthenticated cannot delete.
2. Confirm: the destructive control does not fire on a single misclick.
   Cancel leaves the room intact. Test behaviour, not a widget library.
3. Modal copy asserts the categories above (user-visible text), not a
   CSS class.
4. After delete, join is not-found; server copies and durable content
   are gone.

**Blocked by:** 01 — Search, enter, and original created date

**Hands off to ticket 06:** One-row delete only. Export/reuse one delete
path so bulk delete cannot skip server copies.

**Status:** ready-for-agent

- [ ] Delete removes the room completely (same as today's server delete).
- [ ] Dashboard table no longer shows that row; searching for its name
      does not find it.
- [ ] Visiting `/rec/{slug}` after delete is not-found, not a locked or
      expired shell.
- [ ] Modal lists server audio, research in the room, tab content,
      transcript, and that local WAVs remain; confirmation required;
      cancel leaves the room intact.
- [ ] TDD on the seams above. Do not assert "SQL DELETE was invoked";
      assert the room cannot be loaded and files/content are gone.
- [ ] Coverage: happy delete, cancel, unknown slug, unauthenticated.
- [ ] E2E: create a room, see it on the dashboard, open delete modal,
      assert the warning names the destroy list, confirm, gone from
      table; `/rec/{slug}` not-found path. Second test: open confirm,
      cancel, room still listed and enterable.
- [ ] Docs: CONTEXT.md — delete is the only way a room disappears;
      contrast guest lock (unusable to guests, still listed).
