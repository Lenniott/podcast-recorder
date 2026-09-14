# 06 — Transcript retires as a Tab, becomes a personal panel facet

**Read first:** `docs/adr/0008-...md` and `CONTEXT.md`'s **Transcript** entry (renamed from Transcript Tab — already rewritten to describe the target state this ticket builds) and its **Transcript Activity** entry (flagged there as referencing a now-nonexistent "Transcript Tab pill" — this ticket is what makes that description true again).

**What to build:**
1. Remove the Transcript pill from the room's main tab strip, and retire the reserved Transcript id's use as a *room-shared, switchable* destination — switching to "view the Transcript" stops being a broadcast action synced across participants.
2. Add a Transcript facet inside the right-side research panel — a toggle between "Transcript" and the existing Annotation feed (from tickets 03/05) — whose selected state is **personal and local to that browser** (a plain local variable/store, not sent over the room's WS), consistent with the panel's existing local collapsed/expanded state. Nobody's screen should change because their co-host looked at the Transcript.
3. The Transcript facet lists Turns, read from the same live transcript state already tracked today — this ticket relocates *where it's rendered*, it does not rebuild how Turns are delivered or ordered.
4. Reuse ticket 05's exact selection-popup component so highlighting a Turn's text offers the same Comment + Custom Prompt actions Notes text already has, producing the same kind of Annotation. Do **not** wire the old per-Turn hover-icon Turn Actions into this new facet — those are being deleted in ticket 07; wire the new popup instead.
5. Move the "something's coming" Transcript Activity pulse from the old pill to whatever toggle/button now opens this facet, so participants still get a heads-up about incoming Turns without the facet already being open.

**One thing to preserve, one thing to retire:** the reserved Transcript id itself can and should still exist server-side as a storage key (e.g. for tagging which Annotations are anchored to Turns rather than Notes text, per ticket 03's per-tab storage default) — what's retired is specifically its use as something a client can `tab_switch` *to*. Don't remove the id everywhere; remove its room-shared-navigation meaning.

**Where to look:** the room's main tab-strip component currently owns the live transcript state (append/replay handlers) and the "is the room currently viewing the Transcript" derived flag tied to the reserved id — that state needs to move to (or become shared with) the research panel component, likely by lifting it to their common parent so both can read it without the tab strip needing to render it. The existing Transcript-view component's Turn rendering is a reasonable starting point for the new facet's layout, even though its current per-Turn action icons are on their way out.

**Blocked by:** 05 (this ticket needs the *complete* popup — Comment and Custom Prompt together — so it's reusing a finished component, not building a partial version of it first).

**Hands off to the next ticket:** Ticket 07 must not start removing the old Definition/Facts/Answer path until this ticket is verified working end-to-end on real Turns (not just Notes text) — that's the point at which the old path has a fully-equivalent replacement everywhere it used to matter.

**Status:** ready-for-agent

- [ ] The Transcript pill is gone from the main tab strip; viewing it is no longer a room-shared action.
- [ ] The right panel has a Transcript facet and an Annotation feed facet; switching between them affects only the viewing participant's own browser.
- [ ] Highlighting a Turn's text in the Transcript facet offers the same Comment + Custom Prompt popup Notes already has, and produces the same kind of Annotation, correctly anchored to that Turn.
- [ ] The Transcript Activity pulse is visible from wherever a participant would now discover that new Turns are arriving.
- [ ] No client-side code path can still `tab_switch` to the reserved Transcript id as a room-shared view; the id may still exist purely as a server-side storage key.
