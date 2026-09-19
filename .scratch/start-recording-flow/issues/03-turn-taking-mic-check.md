# 03: Turn-taking mic check on synced start

**Read first:** this folder's README; ticket 02 (the Synced Recording
Session this attaches to). Glossary to add: **Check Turn** (whose turn it
currently is in the sequence below).

**What to build:** Today, the single-person `RecordingCheckModal` opens
independently and simultaneously for whoever presses their own Start —
each person reads a phrase and listens back on their own, with no
awareness of the other's check, which is exactly what makes it impossible
for the host to focus if the guest is also mid-check. Replace this with a
sequenced pair on top of ticket 02's synced start: host's check runs
first (existing single-person flow — read a phrase, "Listen back,"
self-confirm "Yes, continue" or "Something's wrong" — reused as-is), and
while it runs, the guest sees a "please stay quiet, it's the host's turn"
state instead of their own check. Once the host confirms, the same flow
runs for the guest, with the host now shown the "stay quiet" state.
Recording is genuinely running throughout (per the existing single-person
precedent — "nothing here is a throwaway test take") but nothing is
considered the real take until ticket 04's clap fires after both turns
pass.

**Where to look:** `src/lib/recording/recording-check.js` — the state
machine behind the modal (`open`, `sentence`, `confirm()`, `reject()`,
`buildPreview()`); `RecordingCheckModal.svelte` for the UI (`onListen`,
`onConfirm`, `onReject` props) — reuse this component for each person's
own turn rather than building a new one. `recording-check-share.js` +
the `sendRecordingCheckPreview`/`confirmRecordingCheck`/
`rejectRecordingCheck` functions in `+page.svelte` (~line 611-629) for
how a check's state is currently relayed — this ticket needs the *other*
peer's turn-state (not just the preview clip) relayed too, so extend this
module rather than adding a parallel one. `RoomPresenceTable.svelte`
already renders per-peer status columns (recording/checking) — the new
"stay quiet, it's X's turn" state likely belongs there or immediately
adjacent, not a brand new component.

**Out of scope:** the clap/countdown marker that ends this sequence is
ticket 04 — this ticket only needs to emit a clear "both turns passed"
signal for 04 to consume. What happens on a rejected check (retake
filename handling) is ticket 05 — this ticket only needs `reject()` to
correctly abort/restart the *sequence* (e.g. back to the host's turn, or
whichever turn failed), not decide the file naming.

**TDD seams:**

1. Unit: sequence state machine — starts at host's turn; guest's own
   check UI is inert/hidden during host's turn; advances to guest's turn
   only after host's `confirm()`; both-turns-passed is a single
   observable state 04 can subscribe to.
2. Unit: `reject()` on either turn returns the sequence to a well-defined
   retry point (does not silently advance, does not corrupt the other
   peer's turn state).
3. Unit: the "stay quiet" state is derived only from the sequence's
   current turn, not from raw mic/level input (keeps with the
   confirmed-write invariant — no inferring from live audio).
4. Component: `RecordingCheckModal` renders for the peer whose turn it
   is; the other peer's screen shows the quiet-state instead of a second
   modal.
5. E2E: two-peer room, synced start (ticket 02) fires the sequence; host
   completes their check; guest's modal appears only after; guest
   completes theirs; both-turns-passed signal observed (can be asserted
   via whatever hook 04 will consume, even before 04 exists — a test
   double is fine here).

**Blocked by:** 02 — Synced recording session core.

**Status:** ready-for-agent

- [ ] On synced start, host's check runs first using the existing
      single-person modal/flow unmodified in its own mechanics.
- [ ] Guest sees an explicit "it's the host's turn, please stay quiet"
      state during the host's check — not their own check UI, not a
      blank screen.
- [ ] Guest's check runs after host's `confirm()`, with host shown the
      symmetric "stay quiet" state.
- [ ] A reject on either turn returns to a well-defined retry point
      without corrupting the other peer's state.
- [ ] Nothing about the existing single-person check mechanics (listen-
      back sourced from confirmed-written audio, never live) changes.
- [ ] Both-turns-passed emits one clear, subscribable signal.
- [ ] TDD on the seams above.
- [ ] Coverage: host-turn pass/reject × guest-turn pass/reject.
- [ ] E2E: full two-peer turn-taking sequence, in order, with the quiet-
      state visible on the non-active peer's screen.
- [ ] Docs: `CONTEXT.md` **Check Turn** entry; note in AGENTS.md that the
      "stay quiet" indicator must stay sourced from sequence state, not
      live mic level.
