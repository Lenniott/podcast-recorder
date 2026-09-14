# 05: Bulk delete and bulk reactivate

**Read first:** tickets 03 and 04 (the one-row actions this must reuse).
Folder README: bulk = delete + reactivate on the current selection.

**What to build:** The host can **select several rows** (and select-all
on the current search results) and run **Reactivate** or **Delete** on
that set. Delete still confirms. Search + selection interact honestly:
select-all means "all currently visible rows", not hidden matches.

Each item uses the **same** lifetime-reset and complete-delete helpers as
the one-row tickets. No second implementation that forgets server copies
or rewrites `created_at`.

**Where to look:** table from 01, actions from 03–04. Prefer one batch
action that takes slugs + verb over N parallel copy-pasted form posts,
but the server must still authorize like the one-row actions.

**TDD seams:**

1. Selection model: toggle one, select-all visible, clear; rows not in
   the current filter are not selected by select-all.
2. Batch reactivate: N slugs, each lifetime clock moves, created dates
   do not; unknown slugs skipped without aborting the rest (or all-or-
   nothing — pick one, document it, test it).
3. Batch delete: N slugs gone completely after confirm; cancel deletes
   none.
4. Empty selection: bulk controls do not no-op-silently in a way that
   looks successful — disabled or an honest message.

**Blocked by:** 03 — Reactivate a room from the dashboard; 04 — Delete a
room completely from the dashboard

**Hands off:** End of the line. If CONTEXT.md still describes the
dashboard as usage-only, this ticket finishes that entry.

**Status:** ready-for-agent

- [ ] Checkboxes per row; select-all applies to the **filtered** list.
- [ ] Bulk reactivate: selected rooms become enterable; created dates
      unchanged.
- [ ] Bulk delete: after confirm, selected rooms are gone completely;
      unselected rows remain.
- [ ] Cancel on bulk delete leaves every selected room intact.
- [ ] One-row helpers are reused; no forked delete/reactivate.
- [ ] TDD on the seams above. Do not snapshot the whole table DOM.
- [ ] Coverage: mixed expired+active selection, filter+select-all, empty
      selection, partial unknown slugs.
- [ ] E2E: three rooms; search so two are visible; select-all; bulk
      reactivate (after expiring them) OR bulk delete — at least one e2e
      for each verb. Include cancel-bulk-delete. Include "select-all does
      not include a row hidden by search".
- [ ] Docs: CONTEXT.md **Usage Dashboard** documents bulk select,
      select-all-visible, bulk delete, bulk reactivate.
