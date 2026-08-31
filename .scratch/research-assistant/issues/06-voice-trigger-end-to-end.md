# 06 — Voice Trigger end-to-end

**What to build:** while a participant is recording (and therefore, per
ticket 03, having their speech recognized), a finalized utterance that
matches a Voice Trigger phrase (ticket 02's detection) creates a research
entry the same way tickets 04/05 already do — filed under whichever Tab is
currently the room's shared active tab. The prompt sent to the AI combines
two different sources on purpose: the recent spoken conversation, always
read from the Transcript tab specifically (regardless of which tab happens
to be active when the trigger fires — a *voice* trigger is about what was
said, not what's on screen), plus the active tab's own text for grounding
(which may or may not be the Transcript tab). This is the one place in the
feature where "the tab we're on" applies only to the grounding half, not
the conversation half — Quick Actions (ticket 05) stay strictly
single-tab, no exception.

**Blocked by:** 02, 03, 04

**Status:** ready-for-agent

- [ ] A recognized utterance containing a Voice Trigger phrase with an
      explicit topic (e.g. "let's look up the Monroe Doctrine") produces
      an entry answering that topic.
- [ ] A recognized utterance containing a Voice Trigger phrase with no
      explicit topic (e.g. "let's look that up") still produces a
      relevant entry, using recent conversation from the Transcript to
      infer what "that" refers to.
- [ ] The conversation context used always comes from the Transcript tab's
      recent lines, regardless of which tab is currently active when the
      trigger fires.
- [ ] The notes/grounding half of the prompt uses only the currently
      active tab's text — if that active tab happens to be the Transcript
      tab itself, grounding and conversation context are naturally the
      same source; if it's a different tab, grounding comes from that tab
      specifically, not any other.
- [ ] The resulting entry is filed under whichever tab was active at the
      moment the trigger fired, and is broadcast to every participant
      (ticket 04's mechanism).
- [ ] Either participant's spoken trigger phrase works — it's not
      host-only.
- [ ] A trigger phrase spoken by a participant who is not currently
      recording never fires anything (consistent with
      `docs/adr/0003-voice-trigger-consent-tied-to-recording.md` — no
      recording, no listening).
- [ ] A stray/incidental match (e.g. "that's hard to define" catching the
      bare "define" trigger) still degrades gracefully — it just produces
      one extra, easy-to-ignore entry, never an error or a stuck pending
      state.
