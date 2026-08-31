# 05 — Quick Actions

**What to build:** the five canned buttons (Define, Key facts, Fact-check,
Find examples, Analyze) shown in the Research Assistant panel (ticket 04).
Clicking one sends the currently active tab's full text — never a
selection, never another tab's text — through ticket 02's prompt-building
and endpoint, creating an entry the same way the manual ask box does in
ticket 04.

**Blocked by:** 04

**Status:** ready-for-agent

- [ ] Each of the five buttons is visible in the panel and, when clicked,
      creates a pending-then-answered (or errored) entry filed under the
      currently active tab, using ticket 04's existing entry mechanism.
- [ ] The request sent to the AI contains only the currently active tab's
      full text — verify explicitly that switching tabs and clicking a
      Quick Action never includes another tab's content, even when other
      tabs have substantial text.
- [ ] A button is disabled (not just silently a no-op) when the active tab
      has no text to act on.
- [ ] Clicking a Quick Action works regardless of recording state
      (`docs/adr/0003-voice-trigger-consent-tied-to-recording.md`).
- [ ] Works the same whether the active tab is an ordinary Notes tab or
      the read-only Transcript tab from ticket 01 (i.e. a Quick Action can
      run against the transcript-so-far, not just typed notes).
