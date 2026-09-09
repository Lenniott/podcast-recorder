# 03 — Highlight → Comment → shared Annotation feed

**Read first:** `docs/adr/0008-...md` and `CONTEXT.md`'s **Annotation** and **Comment** entries. This is the first vertical slice through the whole Annotation stack (data model + WS protocol + panel UI) — deliberately using the simplest author type (a person's own Comment) so the anchoring/data-model risk is proven before ticket 05 adds AI-authored Cards on top of the same stack.

**What to build:** Selecting a span of text inside Notes shows a small floating popup near the selection with (at minimum, for this ticket) a **Comment** action. Choosing it opens a short input; submitting creates an **Annotation** — stored server-side, broadcast to every participant, and rendered in a new Annotation list in the right-side panel. An Annotation records: which tab it's anchored to, a **frozen quote** of the exact text that was highlighted at creation time (this is the Annotation's permanent record — never recomputed, never replaced), who authored it, and the note's own text.

**Message shapes to use** (mirror the existing `research_ask` / `research_resolve` / `research_entry` / `research_state` naming and structure already used for research entries — same style, new `annotation_` prefix, found in the room's WS message handling and its paired room-state module):
- `annotation_create` (client→server): `{type:'annotation_create', tabId, id, kind:'comment', quote, text}`. Unlike `research_ask`, a Comment's content is already fully known client-side (a person just typed it) — there's no pending/resolve round trip. The server validates, stores, and broadcasts the finished entry directly.
- `annotation_entry` (server→clients, broadcast): `{type:'annotation_entry', tabId, entry}` — one Annotation added, mirrors `research_entry`.
- `annotation_state` (server→client, on join/resync): `{type:'annotation_state', tabId, entries}` — full replay for a tab, mirrors `research_state`.

**Storage default (flag back if wrong):** Store Annotations per-tab, the same way research entries are stored today (a parallel collection keyed by tab id) — the panel shows the active tab's Annotations, matching how research entries are already scoped. This wasn't explicitly settled in the design conversation (which only said "the panel is a list of comments from the content") — it's the lowest-risk default because it matches an existing, working pattern. If a room-wide flat list across every tab was actually intended, that's a different (larger) change — raise it rather than guessing further.

**Where to look:** the room's WS message handler and its paired room-state-store module implement `research_ask`/`research_resolve`/`research_entry`/`research_state` today — that's the structural pattern to mirror (message shapes, per-tab storage, replay-on-join), even though a Comment's server-side handling is simpler (no async resolve step, since nothing needs to be computed). The right-side research panel component is where the new Annotation list renders.

**Blocked by:** 01 (needs the `contenteditable` Notes surface to attach a selection listener to).

**Hands off to the next ticket:** Ticket 04 needs the exact stored-Annotation shape, especially that `quote` is frozen at creation and never recomputed. Ticket 05 needs (a) the same `annotation_entry`/`annotation_state` plumbing, (b) the same popup component — documented well enough that ticket 05 can add a second action to it rather than building a new popup — and (c) the `kind` discriminator values in use so far (`'comment'`), since ticket 05 adds `'card'`.

**Status:** ready-for-agent

- [ ] Highlighting text in Notes shows a popup with a Comment action.
- [ ] Submitting a Comment creates a room-shared Annotation every participant sees.
- [ ] The panel shows the frozen quote alongside the comment text.
- [ ] Rejoining a room replays existing Annotations for the active tab.
- [ ] Guest Research Access gating is deliberately **not** applied to Comments (a plain human note isn't a Research Assistant action) — confirmed as intentional, not an oversight, since ticket 05's Custom Prompts *will* be gated by it.
