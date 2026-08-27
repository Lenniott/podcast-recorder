# 12: Add host download button for completed server copies

**What to build:** The host can actually click something in the UI to
download a participant's completed server copy. Ticket 05 built the download
route (`GET /rec/[slug]/server-copy/download`); tickets 06, 07, and 08 each
explicitly deferred wiring an affordance to it as out of their own scope. This
ticket closes that gap — right now there is no way for a real host to reach
the download route except by knowing and typing the URL by hand.

**Blocked by:** None functionally, but do this after ticket 11 (bind
server-copy clientId to owner) lands, since both touch `+page.svelte` and
sequencing avoids overlapping edits — check `.scratch/server-copy-upload/issues/`
for `z_11-...` before starting.

**Status:** done

**Architectural context:** `RoomDetailsPanel.svelte` already renders each
participant's server-copy state as a pill (`pill-copy-unavailable` /
`-progress` / `-complete` / `-failed`, driven by `serverCopyState` /
`serverCopyPercent` props — see `serverCopyStatus()` and the `SERVER_COPY_LABEL`
map). This is host-only functionality: only the host should see/use it (the
download route itself already enforces host-only auth via
`authorizeServerCopyHostRequest`; the UI should not offer a control a guest
can't use). Check how the component already knows whether the current viewer
is the host (search `+page.svelte`/`RoomDetailsPanel.svelte` for how
`role`/`isHost` is determined for "you") and gate the button the same way.

Keep this small and consistent with the existing pill-based layout — a plain
link/button next to (or inside) the `complete` pill state, pointing at
`/rec/[slug]/server-copy/download?clientId=<that participant's clientId>` (or
whatever exact query shape the route already expects — check
`download/+server.js`), doing a normal browser navigation/download rather
than anything fetch+blob-based. No new styling system, no modal — this is a
small addition to an existing component, not a new feature area.

- [x] The host sees a download control next to/within each participant's
      server-copy pill once that participant's copy is `complete`.
- [x] The control is host-only — a guest viewing the same room does not see
      it (or sees it disabled), even though guests see the same pill states.
- [x] Clicking it downloads that participant's actual completed WAV via the
      existing download route — no new server-side logic, this is UI-only.
- [x] No download control appears for `unavailable`, `in_progress`, or
      `failed` states.
- [x] Existing pill states/percent display are unaffected — this only adds
      to the `complete` case.
- [x] `npx svelte-check` and `npm run build` stay clean; existing sidebar
      tests/behavior are unaffected.

**Implementation note:** gating logic (host + `complete` state → show
control) was extracted as a pure, unit-tested function,
`canShowServerCopyDownload({ isHost, state })` in
`src/lib/server-copy-status.js`, rather than left as inline markup
conditions — consistent with how this file already holds the other pure
server-copy display rules. `RoomDetailsPanel.svelte` renders the control as
a plain `<a href="/rec/[slug]/server-copy/download?clientId=...">` (with
`download`), tagged `data-testid="server-copy-download"` for ticket 13's
Playwright suite to select on. Real click-through/interaction coverage is
ticket 13's job, not this one's — this repo has no Svelte component test
harness (confirmed by prior tickets in this series), so validation here is
manual reasoning plus `svelte-check`/`vitest`/`build`.
