# 06 — Research Mode: passive, gated, server-side transcript monitoring

**Superseded design note:** this ticket originally specified explicit
Voice Trigger phrase detection ("let's look that up" wired end-to-end).
That's replaced — see `docs/adr/0004-research-mode-replaces-voice-trigger.md`
— by a passive, always-on process with no phrase or button required.
`src/lib/research/research-trigger.js` (built for the old design) is no longer part
of this ticket's scope; it can stay unused or be removed, your call, but
nothing in this ticket depends on it.

**What to build:** a per-room, server-side background process — call it
Research Mode — that watches the room's Transcript (ticket 01) and
surfaces things on its own, with nobody asking. Two stages per tick, run
every 2 seconds while the room has at least one connected participant:

1. **Gate Check.** Skip the tick entirely (no call at all) if the last 2
   seconds added no new Transcript lines, or fewer than 5 new words.
   Otherwise, send the last 10 seconds of Transcript to a cheap, fast,
   no-web-search model (env-configurable, e.g. `OPENROUTER_GATE_MODEL`,
   defaulting to something like `openai/gpt-oss-120b`) asking only: is
   there something here worth researching? A yes/no verdict, nothing more
   — this call never itself produces anything shown to a participant.
2. **Deep Check.** Only if the Gate Check said yes: send the last 10
   *minutes* of Transcript to the existing Research Assistant Client
   (`src/lib/server/research-assistant.js`, ticket 02) — extend it with a
   new request kind (alongside `voice`/`quickAction`) rather than
   reshaping what's there. Include a rolling list of facts already
   surfaced this session so it doesn't repeat itself — no new
   similarity/embedding infrastructure needed, just pass the list as
   context and let the model self-censor duplicates.

A successful Deep Check is filed as a research entry under the Transcript
Tab specifically (`TRANSCRIPT_TAB_ID`, `room-state-store.js`) — not
whatever tab happens to be active, since this isn't about any particular
tab's content. Since the server is both the asker and the one who already
has the answer, it creates *and* resolves the entry itself, straight
through the same `addResearchEntry`/`resolveResearchEntry` calls and
`research_entry` broadcast ticket 04 already built — no new WS message
types, no new client-side UI at all. A failed Gate or Deep Check (timeout,
upstream error, whatever) is logged server-side and the tick is simply
skipped — never a visible error, since nobody asked and nobody's waiting.

The per-room timer starts when the room gets its first participant and
stops when it empties — reuse the same occupancy hooks
(`onParticipantJoined`/`onParticipantLeft`) the Room State Store's grace
timer already relies on, don't invent a second occupancy tracking
mechanism. Research Mode only ever has something to watch when a
participant is recording (that's the only way Transcript lines get
created at all — ticket 03), so it inherits the existing consent boundary
(ADR-0003) for free, with nothing new to build for it.

**Blocked by:** 01, 02, 03, 04

**Status:** ready-for-agent

Read first: `CONTEXT.md`'s Research Mode / Gate Check / Deep Check
entries, and `docs/adr/0004-research-mode-replaces-voice-trigger.md` for
the full reasoning behind the two-stage shape and the cost/noise problem
it solves.

**Confirmed test seams (`/tdd`) — test only at these:**
1. The new Gate Check function (in or alongside
   `research-assistant.js`) — tested directly with an injected fetch, no
   real network, covering: the yes/no verdict parsing, the model/env-var
   selection, and that it never enables web search.
2. `askResearchAssistant`'s new request kind for the Deep Check — tested
   directly with an injected fetch, same style as the existing
   `voice`/`quickAction` kinds, covering the "already surfaced" list being
   included in the prompt.
3. The per-room orchestration module (new — e.g.
   `src/lib/server/research-mode.js`) — tested with an injected fake
   clock/timer (no real 2-second waits) and injected fake Gate/Deep Check
   functions, proving: a tick is skipped entirely below the 5-word/2-second
   threshold, the Deep Check only ever runs after a Gate Check says yes,
   a successful Deep Check creates+resolves an entry under
   `TRANSCRIPT_TAB_ID` via the Room State Store, a failed Gate or Deep
   Check never creates a visible/stuck entry, and the timer starts on the
   room's first join and stops on its last leave.

No Playwright e2e coverage is expected for this ticket specifically — the
LLM calls happen server-side, not from the browser, so there's no
same-origin request a `page.route()` can intercept the way
`mockResearchEndpoint` does for ticket 04/05's client-initiated asks.
Real end-to-end behavior (does a real conversation actually get
fact-checked well, is 2s/10s/10min/5-word tuned right) needs manual
verification with a real `OPENROUTER_API_KEY`, same as ticket 02.

- [ ] A tick with fewer than 5 new words (or none) in the last 2 seconds
      makes no call at all — not even the cheap one.
- [ ] A Gate Check never enables web-search grounding, reads its model
      from its own env var (separate from `OPENROUTER_MODEL`), and its
      verdict is parsed reliably (not by loosely string-matching free text).
- [ ] A Deep Check only ever runs when the immediately preceding Gate
      Check for that tick said yes.
- [ ] A Deep Check receives the last 10 minutes of Transcript (not just
      the last 10 seconds the Gate Check saw) and the list of facts
      already surfaced this session.
- [ ] A successful Deep Check's result appears under the Transcript Tab
      for every connected participant, via the existing broadcast — never
      under whichever tab happens to be active if that's a different one.
- [ ] A failed Gate or Deep Check produces no visible entry, no stuck
      pending state, and doesn't crash or stop the next tick from running.
- [ ] The per-room timer starts when the room's first participant joins
      and is cleared when the room empties — no dangling timer for a room
      nobody is in.
- [ ] Two or more rooms run independent Research Mode timers with no
      cross-room leakage of "already surfaced" facts or timing state.
