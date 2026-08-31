# 04 — Research Assistant right panel (shell) + manual ask

**What to build:** the collapsible right-side Research Assistant panel. It
shows, for whichever Tab is currently the room's shared active tab, that
tab's own history of research entries (question/prompt → pending →
answered or errored) — switching the room's active tab switches which
history is visible. A manual "ask a question" box is the one way to create
an entry in this ticket (Quick Actions and Voice Trigger, tickets 05/06,
reuse this same mechanism). An entry created by any participant is
broadcast to every other participant and stored as a new content kind on
the Room State Store (ticket 00) — the same lifecycle as tabs/text/video
and ticket 01's transcript: in memory while the room is occupied, flushed
to durable storage and evicted after the last participant leaves (the
grace period is env-configurable — `ROOM_STATE_GRACE_MS`, default 10s;
the e2e suite runs it at 200ms, see `playwright.config.js`), restored on
the next join. See
`docs/adr/0002-transcript-tab-append-only-shared-state.md`'s note that
Research Assistant results are shared the same way as the transcript, and
ticket 00's brief for why this Store was built to take a new content kind
like this without changing its interface.

**Blocked by:** 02, 00

**Status:** ready-for-agent

- [ ] The panel can be collapsed/expanded independently of the existing
      left sidebar, and its collapsed state is a local, per-browser UI
      preference — not synced to the room, matching how `sidebarCollapsed`
      already works.
- [ ] Typing a question into the manual ask box and submitting it creates
      a pending entry immediately, which resolves to the AI's answer (via
      ticket 02's endpoint) or a visible error if the request fails —
      never a silent failure.
- [ ] That entry appears in every connected participant's panel, not just
      the one who asked.
- [ ] Entries are scoped per Tab: an entry created while Tab A is active
      is filed under Tab A; switching to Tab B shows Tab B's own
      (possibly empty) history, never Tab A's entries.
- [ ] A participant who (re)joins the room, or requests a resync, receives
      each tab's accumulated research history, the same way they already
      receive tab text/video and (ticket 01's) transcript — including
      after the room was flushed to disk and evicted per ticket 00's
      10-second grace window, not just across a live reconnect.
- [ ] The manual ask box works regardless of whether anyone is currently
      recording — it sends only typed text, not live audio, so it's
      unaffected by the recording-based consent rule
      (`docs/adr/0003-voice-trigger-consent-tied-to-recording.md`).
- [ ] Citations/source links returned by the web-search-grounded answer
      (ticket 02) are visible in the entry, not discarded.
- [ ] Test coverage for the panel's state transitions (pending →
      answered/errored, per-tab scoping) lives in plain, non-Svelte
      modules wherever the logic doesn't need the DOM — this repo's
      coverage thresholds (`vitest.config.js`) exclude `.svelte` files
      entirely, so keep state-transition logic testable outside the
      component, the same way `$lib/exit-guard.js` or
      `$lib/server-copy-status.js` keep decision logic separate from the
      `.svelte` files that use it.
- [ ] A Playwright e2e spec (two contexts, matching the pattern in
      `tests/playwright/guest_notes.spec.js`) covers the manual-ask flow
      end-to-end: broadcast to both peers, per-tab scoping, and the panel
      surviving a room re-join (pairs naturally with
      `room_state_eviction.spec.js`'s pattern). Use
      `mockResearchEndpoint(page, { status, body })`
      (`tests/playwright/helpers.js`) to fake the browser's own call to
      `POST /rec/[slug]/research` via `page.route()` — this is how success
      (200) and the OpenRouter-dependent error codes (502/504) get e2e
      coverage without a real API key; the codes reachable for real
      without one (401/410/400/500 "not configured") already have direct
      route-level coverage in `research_endpoint_status.spec.js` and don't
      need re-mocking here.
