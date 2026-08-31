# 01 — Transcript Tab: protocol, storage, read-only display, expiry-safe cleanup

**What to build:** every room gets one permanent, uncloseable Transcript tab.
Any connected participant's browser can send a new transcript line
(speaker-labeled text) to the server; the server appends it to that room's
in-memory transcript (never replaces, never reorders), broadcasts the
appended line to every connected peer, and replays the full
transcript-so-far to anyone who (re)joins or resyncs — the same pattern the
existing `tabs_sync` replay already uses for tab text/video. The tab
renders as a distinct, read-only view (no editable textarea, can't be
closed, can't be renamed).

While touching this state, also close a pre-existing gap: when a room's DB
row is deleted by the existing expired-room-cleanup job, the matching
in-memory room state (tabs, text, video, and now the transcript) should be
dropped too, instead of living in the server process's memory forever.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

Read first: `CONTEXT.md` (Transcript Tab, Turn, Research Assistant) and
`docs/adr/0002-transcript-tab-append-only-shared-state.md` — the
append-only requirement and the "why not just reuse `tab_text`" reasoning
are both there, and explain why a last-write-wins approach was rejected.
This ticket does not include capturing real speech (that's ticket 03) —
verify this end-to-end with whatever mechanism is natural for sending a
"new transcript line" message, no microphone required.

- [ ] A room's tab list always includes exactly one Transcript tab,
      distinguishable from ordinary tabs, present from the moment the room
      is created.
- [ ] The Transcript tab cannot be closed (exempt from the close action
      regardless of how many other tabs exist) and cannot be renamed.
- [ ] A connected client can send one new transcript line (speaker identity
      + text) to the server; the server appends it to that room's
      transcript, never replacing or reordering previously appended lines.
- [ ] Every other connected peer receives the newly appended line, in
      order, labeled with who said it.
- [ ] A client that (re)connects or requests a resync (mirroring today's
      `tabs_sync`) receives the full transcript accumulated so far, in
      order, before any new live line arrives.
- [ ] Two lines sent at nearly the same instant from two different
      participants both land, in a stable order, with nothing dropped —
      this is exactly the race today's `tab_text` last-write-wins
      mechanism would fail.
- [ ] The Transcript tab's content cannot be edited by hand from the UI.
- [ ] When the expired-room-cleanup job deletes a room's DB row, the
      corresponding in-memory room state for that slug (tabs, text, video,
      transcript) is also dropped — verify this doesn't regress the
      current, intentional behavior of tab/notes state surviving a
      *temporary* all-peers-disconnected gap for a room that is not yet
      expired.
- [ ] Unit/integration test coverage for the append/broadcast/replay logic
      and the expiry-driven cleanup, following this repo's existing test
      conventions (see `tests/unit/tab-sync.test.js` and
      `tests/unit/room-connection.test.js` for the client/server split
      already in place, and `tests/unit/expired-room-cleanup.test.js` for
      the cleanup job's existing test shape).
