# 04 — Annotation anchoring survives edits (or fails honestly)

**Read first:** `AGENTS.md`'s core rule ("never let the UI claim things are fine when they might not be") and `docs/adr/0008-...md`, which applies that exact rule to Annotations: a stale or wrong highlight is the same failure shape as the recording-status bugs AGENTS.md warns about, just in a new place.

**What to build:** Notes text is a shared, editable, last-write-wins string — either participant can edit the text under an existing Annotation's highlighted span at any time. When that happens: re-locate the Annotation's frozen `quote` in the *current* text before drawing its highlight (best-effort — an exact substring search is an acceptable v1 implementation; a full fuzzy/approximate-match algorithm is not required, don't over-build this). If no confident match exists any more (the phrase was edited away or changed), render the Annotation in the panel with its frozen quote exactly as before, but draw **no highlight** anywhere in the text. Never draw a highlight at the wrong location. Never persist a character-offset position as a substitute for this check — the quote plus a live re-match is the whole mechanism, by design (see ADR-0008's anchoring section for why: a persisted offset link is exactly the kind of state that silently goes wrong under concurrent edits).

**Blocked by:** 03.

**Hands off to the next ticket:** Ticket 06 (Transcript panel facet) reuses this same Annotation rendering for Turn-anchored Annotations — but Turns are read-only and append-only (never edited after they land), so an Annotation anchored to a Turn can never go stale and never needs this re-locate logic at all. Make sure your implementation doesn't force Turn-anchored Annotations through the same re-match code path unnecessarily — document the distinction so ticket 06 doesn't have to rediscover it.

**Status:** ready-for-agent

- [ ] Editing Notes text outside a Comment's quoted span leaves its highlight intact.
- [ ] Editing text that removes or changes the exact quoted phrase makes the highlight disappear — it does not jump to a wrong location.
- [ ] The Annotation still appears in the panel with its original quote even when no live match is found.
- [ ] No persisted character-offset field is added to an Annotation's stored shape — matching is computed at render/read time from the frozen quote alone.
