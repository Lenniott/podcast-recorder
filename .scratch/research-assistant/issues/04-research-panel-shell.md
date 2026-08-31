# 04 — Research Assistant right panel (shell) + manual ask

**What to build:** the collapsible right-side Research Assistant panel. It
shows, for whichever Tab is currently the room's shared active tab, that
tab's own history of research entries (question/prompt → pending →
answered or errored) — switching the room's active tab switches which
history is visible. A manual "ask a question" box is the one way to create
an entry in this ticket (Quick Actions and Voice Trigger, tickets 05/06,
reuse this same mechanism). An entry created by any participant is
broadcast to every other participant and stored the same way ticket 01's
transcript is (in-memory, per room, replayed to a (re)joining participant)
— see `docs/adr/0002-transcript-tab-append-only-shared-state.md`'s note
that Research Assistant results are shared the same way as the transcript.

**Blocked by:** 02

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
      receive tab text/video and (ticket 01's) transcript.
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
