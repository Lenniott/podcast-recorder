# 06: Bulk delete and bulk Unlock

**Read first:** tickets 03 and 05, the folder README (selection rules).

**Modules:** add `toggleSlug` and `selectVisible` to the existing
`src/lib/home/dashboard-rooms.js`. Do not create a selection module.
Unlock goes through `unlockGuests`. Delete goes through `deleteRoom` in
a loop. No second implementation of either.

**What the host can do:** select rows and Unlock or Delete the
selection. Select-all uses `selectVisible` on the rooms `filterRooms`
is currently showing, which replaces the selection. A slug the filter
hid is not selected. Changing the query drops slugs that are no longer
visible, so a bulk action cannot hit a room the host cannot see.

Empty selection: both controls are disabled and no request is sent.

Bulk delete uses one confirm. The modal states that every selected room
will be fully removed, and it keeps ticket 05's list of what removal
means (server audio, research, tab content, transcript, annotations, the
room; local WAVs stay). Cancel deletes none.

Unknown slugs are skipped and named. The known ones still unlock or
still delete.

If ticket 04 has shipped, `unlockGuests` already clears inactivity. This
ticket does not grow a special case for it. If 04 has not shipped,
unlock still only moves the guest-lock clock, which is already ticket 03.

**Seams:**

1. `toggleSlug` adds, then removes, the same slug. No duplicates.
2. `selectVisible` on a filtered pair returns those two slugs and not
   a third that was in the previous selection but is not in `visible`.
3. `unlockGuests` with two real slugs and one unknown: both clocks move,
   both `created_at` values do not, the unknown is in `missing`.
4. The page action deletes two slugs through `deleteRoom` and leaves a
   third. Cancel sends nothing: all three remain.
5. Empty selection does not call unlock or delete.

**Blocked by:** 03 and 05. Not by 04.

**Status:** ready-for-agent

- [ ] A checkbox per row. Select-all is the filtered list only.
- [ ] Bulk unlock: selected rooms are open to guests; created dates
      unchanged; a missing slug is reported.
- [ ] Bulk delete: after confirm, selected rooms are gone; unselected
      rows remain; a missing slug does not abort the others.
- [ ] Cancel leaves every selected room intact.
- [ ] `unlockGuests` and `deleteRoom` are the calls. No forked copy.
- [ ] TDD on the seams above. Do not snapshot the table.
- [ ] Coverage: mixed selection, filter then select-all, empty
      selection, unknown slug among real ones, cancel.
- [ ] E2E: three rooms; search so two are visible; select-all; the
      hidden room is not part of the action. One spec for bulk unlock
      (created-date text unchanged on the two). One spec for bulk
      delete (those two gone, the hidden one still listed). One spec
      for cancel on bulk delete.
- [ ] Docs: CONTEXT.md **Usage Dashboard** says the host can select the
      rooms currently shown and unlock or delete that selection.
      Select-all is the visible rows.
