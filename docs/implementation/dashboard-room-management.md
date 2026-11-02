# Dashboard room management

Implemented on `cursor/dashboard-room-management-011d`. This record replaces
stale `ready-for-agent` statuses in `.scratch/dashboard-room-management`.
The acceptance lists there preserve the original design, rather than
claiming a retrospective audit of every original TDD step.

## Delivered behavior

| Slice | Behavior | Browser coverage |
| --- | --- | --- |
| 01 | Search loaded rooms by name/slug, enter by room link, original created date in UTC | `dashboard_find_enter.spec.js` |
| 02 | Rooms, durable content, and server copies persist until explicit delete | `dashboard_room_persists.spec.js` |
| 03 | Time lock after server-known audio; host exemption; dashboard Unlock preserves created date | `dashboard_guest_lock.spec.js` |
| 04 | Per-client inactivity lock after a long server copy; successful admission refreshes access; Unlock clears lock | `dashboard_guest_inactivity.spec.js` |
| 05 | Confirmed complete delete; cancel retains room; local WAVs remain | `dashboard_delete_room.spec.js` |
| 06 | Select visible rooms, bulk unlock/delete, clear selection on search change, skip and name missing rooms | `dashboard_bulk.spec.js` |
| Follow-up | Join password under Room code; legacy missing plaintext shows Unavailable | `dashboard_find_enter.spec.js` |
| Follow-up | Socket refusal shows locked message and waits for explicit retry | `dashboard_socket_lock.spec.js` |

Delete also removes `guest_room_access` for the deleted slug and retains other
rooms' access. Research usage totals intentionally outlive room deletion.
Missing rooms are returned to the page as action feedback, including after a
partially successful batch. They no longer disappear into a success redirect.

## Decisions that differ from the original ticket text

- `guest-join.js` owns `guestJoinDecision`, `anyGuestLocked`, `unlockRoom`, and
  `noteAdmittedGuest`. The page and socket share the decision. Access is stamped
  after authentication/admission; a refusal, wrong password, or host never stamps it.
- The authenticated page remembers the browser clientId with its room cookie;
  inactivity is checked by HTTP and socket entry. A missing access row is stale,
  even with a fresh lock clock. Unlock stamps every known guest's access.
- HTTP refusals redirect to `/?guestlocked=1` with the existing reassurance that
  the host can still enter. Socket refusals stay on the room page and say
  "This room is locked. Ask the host to unlock it." The page keeps local
  recording controls available; automatic socket retries stop on code 4403.
- Created date uses the existing unambiguous English UTC format, such as
  `2 Nov 2026, 15:04 UTC`, rather than the original ISO-like example.
- Filter and selection live in `room-table-filter.js` and `room-selection.js`.
  Single and bulk delete share `deleteDashboardRoom` and `deleteRoom`.
- The deployed environment names are `GUEST_LOCK_HOURS`,
  `GUEST_LOCK_RECORDING_MINUTES`, and `GUEST_LOCK_INACTIVITY_HOURS`.

## Verification

Unit tests cover guest-lock boundaries, host exemption, authentication, retained
created dates, deletion, missing rooms, and batch behavior using the real SQLite
harness where applicable. The follow-up code/data, deletion cleanup, missing-room,
and socket-close regressions were each observed failing before their fixes.

The original flaky browser run reproduced the delete/search failure and host
navigation failure with retries disabled. Search now remains disabled until
its input handler mounts, browser helpers wait for that readiness, and delete
waits for the old confirmation dialog to close before interacting with the new
page. A traced host-entry request returned HTTP 200 quickly, but the URL
assertion could take over five seconds. The shared E2E database contained
about 2,400 rooms, creating tens of thousands of table cells and slow client
work on every home visit. Each run now uses a fresh temporary database and
server-copy directory, shared with fixture-writing workers through exported
E2E paths. Existing data is retained. The navigation assertions keep their
original deadline; no sleeps or repeated link clicks were added.


Commands:

```sh
npm test
npm run test:coverage
npx svelte-kit sync && npx svelte-check
npm run build
npm run test:mutation:dashboard
E2E_PORT=5193 E2E_WS_PORT=3093 npx playwright test --retries=0
```

Mutation reports are written to `reports/mutation/dashboard/`. The config scopes
DB mutations to guest-access/unlock/delete functions and socket mutations to
admission and access-stamping guards; the home route includes its action
authorization. The command enforces an 80% minimum; survivors still require review.

Mutation result: **81.84%**, 622 of 760 mutants detected, 138 survivors,
zero uncovered mutants and zero timeouts. Selection is 17/17 detected.
Socket entry is 25/27 detected; its two survivors only change the close-reason
string. The app handles the unchanged 4403 code and server error message.
The first run was 76.94%; added assertions cover retained selections,
name-only search, malformed dashboard cookies, missing-room feedback,
post-unlock row status, storage-read failure, and actual usage/content/audio
aggregation rather than only empty-room defaults.

The remaining survivors include equivalent defensive guards, other month/date
formatting examples, malformed inputs outside the HTTP string contract, and
older home-route behavior (prompt editing, room creation, cookie options and
logging). These remain visible in the report; the mutation baseline does not
claim that every surviving mutation is equivalent.

## Final verification — 2 November 2026

- Unit coverage run: **1,328 tests passed** across 71 files. Statements
  94.53%, branches 87.73%, functions 95.07%, lines 96.70%; configured
  thresholds passed.
- Plain-Node server import check passed. Production build passed.
- Svelte check: zero errors and zero warnings. `svelte-check` is now a
  development dependency, rather than requiring an unpinned `npx` download.
- All 12 room-management browser scenarios passed with retries disabled.
  Six delete/lock/persistence scenarios were repeated twice in a second fresh
  run: **12/12 passed**, again without retries. The single-delete fixture now
  creates its own retained room, so its "No rooms match" assertion does not
  depend on earlier scenarios leaving rooms behind.
- Full browser suite with retries disabled: **101 passed, one skipped, one
  failed** in 5.4 minutes. The skipped site-password test requires a site gate,
  while the default E2E server intentionally disables that gate.
- The failure was `voice_capture.spec.js`'s shared interim-pulse scenario:
  speech-recognition start count remained zero and the room showed Start
  Recording after the checks. Three isolated repeats of that exact scenario
  all passed. This full-suite flake remains unresolved; this work does not
  claim to fix the voice-capture/recording path.
- Final dashboard mutation run, including socket guards: **81.84%**, above
  the enforced 80% minimum. See the survivor notes above.

## Checkbox checkmarks — 2 November 2026

A real DuckDuckGo click reproduced a mismatch: a row became selected for bulk
operations while its native checkbox stayed unchecked. The click handler used
`preventDefault`, so the browser rolled back its checkbox toggle after Svelte
updated selection. Row and select-all handlers now use `change`, preserving
native mouse and keyboard behavior.

The browser regression asserts actual checked states after row clicks,
deselection, Space, and select-all, alongside bulk-control availability. It
failed before the fix and passed twice without retries afterward. The corrected
checkmark was also verified visibly in DuckDuckGo. Svelte check passed with zero
errors and warnings.

## Guest status and row actions — 2 November 2026

Guest access is an explicit badge with a lock/check icon and the existing
warning/neutral text colors. Unlock is grouped with Delete under Actions and
is shown only for a locked room. The Actions column stays visible during
horizontal scrolling. Unlocking changes the badge to Open to guests and
removes the Unlock button. Bulk unlock is disabled unless a locked room is
selected, and posts only the selected locked slugs; open-room clocks are
left alone by dashboard controls. The server API still permits an explicit
clock reset for an open room.

The row-visibility/placement and open-selection eligibility regressions failed
before their changes. Browser coverage checks the transition from open to
locked and back, placement with Delete, and unavailable Unlock on open rooms.

Table styling uses shared theme tokens throughout. Room links and open-status
badges use neutral text, with warning color reserved for locked status. Room
codes inherit the table font. Selected checkboxes use the primary button green;
keyboard focus uses the normal text color, avoiding the dark-theme mint accent.
