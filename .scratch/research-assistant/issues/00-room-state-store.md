# 00 — Room State Store: a deep module for hot (RAM) vs. durable (disk) room content

**What to build:** today, `ws-rooms.js` holds a room's tabs/text/video
directly in two plain in-memory `Map`s, poked at inline from every WS
message handler, and never written to disk — a server restart loses it,
and a room that empties out just sits in RAM forever (nobody ever deletes
it, even after the room's DB row expires). This ticket replaces that with
one small, well-tested module — the **Room State Store** — that owns the
whole lifecycle: where a room's live content currently lives, when it
moves to disk, and when it comes back.

Behavior: while at least one participant is connected, a room's content
lives in memory (fast — no disk I/O on every keystroke or transcript
line). The moment the *last* participant disconnects, a **10-second grace
timer** starts. If nobody reconnects within that window, the room's
content is written to durable storage (the existing SQLite DB — extend
`db.js`'s setup rather than inventing a second storage mechanism) and
dropped from memory. If a participant reconnects before the timer fires,
the flush is cancelled and the room just keeps running hot, exactly as if
nobody had left. When a room is next joined (whether it was ever evicted
or not), the Store transparently loads its content from disk if it isn't
already hot — callers never need to know or care which case they're in.

Deep-module shape: the Store's interface should be small and intent-based
(e.g. "get this room's content," "append a transcript line," "set a tab's
text," "a participant joined/left") — not a raw get/set of the whole
structure. Put the actual room-content shape, the RAM/disk decision, the
grace-timer bookkeeping, and each content kind's own invariants (max tabs,
text length cap, "the Transcript tab can't be closed," "a transcript is
append-only") *inside* the module. `ws-rooms.js`'s WS message handlers
should end up only calling this small interface, never touching a raw Map
or a raw DB row directly.

**Extendable, explicitly:** this module is being built now for tabs/text/
video, and ticket 01 will add the Transcript as a second content kind. A
third kind (the Research Assistant's per-tab entries, ticket 04) needs to
slot in later without changing this module's public interface shape.
Design the "content this Store hydrates/flushes" side as something new
kinds can be added to, not something hard-coded to today's two kinds.

**Testable, explicitly:** the grace timer must be driven by an injected
clock/timer (the same pattern already used elsewhere in this repo — see
`room-connection.js`'s reconnect backoff and `server-copy-upload.js`'s
retry `sleep()` — so tests can fast-forward it with fake timers instead of
waiting 10 real seconds). The hot-storage and durable-storage sides should
each be swappable for a test double independently (an in-memory fake DB
for one, a plain object for the other), so the hydrate/flush/evict logic
can be tested without a real SQLite file.

**Blocked by:** None — can start immediately. (Tickets 01 and 04 build on
top of this and are now blocked by it — see their updated "Blocked by".)

**Status:** ready-for-agent

Read first: the current `src/lib/server/ws-rooms.js` (the `rooms` and
`tabRooms` maps, and every handler that reads/writes them directly) and
`src/lib/server/db.js` (the existing SQLite setup this ticket extends) —
this ticket's whole job is to make those handlers no longer need to touch
either directly. `docs/adr/0002-transcript-tab-append-only-shared-state.md`
also matters here: the Store's append operation for the Transcript is
where that guarantee actually gets enforced, not in `ws-rooms.js`.

- [ ] While at least one participant is connected, reading/writing a
      room's content never touches disk — verified as behavior, not just
      implied by the design (e.g. a test double for durable storage that
      fails/throws if called during this phase should still pass).
- [ ] Exactly 10 seconds after the *last* participant disconnects, with
      nobody having reconnected, the room's content is written to durable
      storage and dropped from memory.
- [ ] A participant reconnecting at any point before that 10 seconds
      elapses cancels the pending flush — the room's content is never
      written to disk or dropped in that case, and continues exactly as
      before.
- [ ] A room whose content was flushed and evicted, when next joined, has
      its content transparently restored — indistinguishable to a joining
      participant from a room that was never evicted at all.
- [ ] A brand-new room (never had content before) is handled the same way
      as a restored one, with no special-case in the calling code.
- [ ] A reconnect that races the flush itself (arrives at the exact moment
      the durable write is in flight) never loses the reconnecting
      participant's view of the room's live content, and never leaves the
      room in a state where it's simultaneously "hot" and "evicted."
- [ ] `ws-rooms.js`'s message handlers are updated to call this module's
      interface instead of reading/writing `rooms`/`tabRooms` directly —
      the existing WS protocol and every existing behavior (presence,
      tabs, text, video, resync-on-join) still works exactly as it does
      today, verified by the existing test suite continuing to pass.
- [ ] The now-obsolete manual DB-expiry cleanup path this replaces (the
      gap where `tabRooms` was never pruned — see
      `tests/unit/expired-room-cleanup.test.js`) is either removed or
      folded into this module, not left as a second, competing cleanup
      mechanism.
- [ ] Unit tests cover: hot-path reads/writes touching no disk, the grace
      timer firing and not firing (via fake timers, not real delays), the
      reconnect-cancels-flush case, and hydrate-after-evict — all without
      a real SQLite file or real WebSocket connections.
