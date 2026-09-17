# 06: Bulk delete and bulk Unlock

**Read first:** tickets 03 and 05 (the one-row actions this must reuse).
Folder README: bulk = delete + unlock on the current selection.

**What to build:** The host can **select several rows** (and select-all
on the current search results) and run **Unlock** or **Delete** on that
set. Delete still confirms with the same "what you are destroying"
meaning as ticket 05 (one confirm for the batch is enough if it is
honest that every selected room will be fully removed). Search +
selection interact honestly: select-all means "all currently visible
rows", not hidden matches.

Each item uses the **same** unlock and complete-delete helpers as the
one-row tickets. No second implementation that forgets server copies or
rewrites `created_at`.

**Where to look:** table from 01, actions from 03 and 05. Prefer one
batch action that takes slugs + verb over N parallel copy-pasted form
posts, but the server must still authorize like the one-row actions.

**TDD seams:**

1. Selection model: toggle one, select-all visible, clear; rows not in
   the current filter are not selected by select-all.
2. Batch unlock: N slugs, each guest-lock clock moves, created dates
   do not; unknown slugs skipped without aborting the rest (or all-or-
   nothing — pick one, document it, test it).
3. Batch delete: N slugs gone completely after confirm; cancel deletes
   none.
4. Empty selection: bulk controls do not no-op-silently in a way that
   looks successful — disabled or an honest message.

**Blocked by:** 03 — Guest time lock and dashboard Unlock; 05 — Delete a
room completely from the dashboard

**Hands off:** End of the line. Ticket 04's inactivity lock is cleared
by Unlock if 04 has shipped; if 04 has not, Unlock still resets the
time-lock clock. If CONTEXT.md still describes the dashboard as
usage-only, this ticket finishes that entry.

**Status:** ready-for-agent

- [ ] Checkboxes per row; select-all applies to the **filtered** list.
- [ ] Bulk unlock: selected rooms are open to guests again; created
      dates unchanged.
- [ ] Bulk delete: after confirm, selected rooms are gone completely;
      unselected rows remain.
- [ ] Cancel on bulk delete leaves every selected room intact.
- [ ] One-row helpers are reused; no forked delete/unlock.
- [ ] TDD on the seams above. Do not snapshot the whole table DOM.
- [ ] Coverage: mixed locked+open selection, filter+select-all, empty
      selection, partial unknown slugs.
- [ ] E2E: three rooms; search so two are visible; select-all; bulk
      unlock (after locking them) OR bulk delete — at least one e2e
      for each verb. Include cancel-bulk-delete. Include "select-all does
      not include a row hidden by search".
- [ ] Docs: CONTEXT.md **Usage Dashboard** documents bulk select,
      select-all-visible, bulk delete, bulk unlock.
