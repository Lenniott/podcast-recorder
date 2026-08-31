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

The transcript is one of the room content kinds the Room State Store
(ticket 00) now owns the lifecycle of — it lives in memory while the room
is occupied, and is flushed to durable storage and evicted 10 seconds
after the last participant leaves, the same as tabs/text/video. This
ticket adds the transcript as a new content kind on that Store rather than
inventing a second, parallel storage mechanism.

**Blocked by:** 00

**Status:** ready-for-agent

Read first: `CONTEXT.md` (Transcript Tab, Turn, Research Assistant),
`docs/adr/0002-transcript-tab-append-only-shared-state.md` — the
append-only requirement and the "why not just reuse `tab_text`" reasoning
are both there, and explain why a last-write-wins approach was rejected —
and ticket 00's brief for the Store interface this builds on. This ticket
does not include capturing real speech (that's ticket 03) — verify this
end-to-end with whatever mechanism is natural for sending a "new
transcript line" message, no microphone required.

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
- [ ] A transcript that was flushed to disk and evicted (per ticket 00's
      10-second grace window) comes back in full, in order, when the room
      is next joined — indistinguishable from a transcript that was never
      evicted.
- [ ] Unit/integration test coverage for the append/broadcast/replay
      logic, following this repo's existing test conventions (see
      `tests/unit/tab-sync.test.js` and `tests/unit/room-connection.test.js`
      for the client/server split already in place).
