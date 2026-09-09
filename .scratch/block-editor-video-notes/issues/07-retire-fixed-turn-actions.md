# 07 — Retire Definition/Facts/Answer and their scoring plumbing

**Read first:** `docs/adr/0008-...md`'s Consequences section (names exactly what this ticket removes) and `CONTEXT.md`'s **Definition**/**Facts**/**Answer**/**Turn Action**/**Focus Turn**/**Grounding**/**Research Prompt**/**Research Prompt Title**/**Custom** entries — all already marked retired there, pointing here.

**What to build:** By ticket 06, every real use of the old fixed Turn Actions has an equivalent, fully-working replacement (Custom Prompts, triggered from a highlight, on both Notes and Transcript). This ticket deletes the now-dead old path rather than leaving it as unreferenced cruft:
1. The old per-Turn hover-icon UI wired to Definition/Facts/Answer (ticket 06 already stopped using this component for the new Transcript facet — this is cleanup, not a behavior change for any participant at this point).
2. The structured-output/suppression logic behind those three modes: the hardcoded per-mode system-prompt rules, the auto-suppress scoring (a "how well-known already" / "already settled in the transcript" numeric gate), the enforced JSON response schema used only for those three modes, and the fixed list of valid Turn Action ids.
3. The request-building and Focus/Grounding-window logic that only existed to feed that structured path (finding a Turn by id, computing its fixed neighbor window).
4. The wiring between the tab-strip and the research panel that only existed to track "which Turn Actions have already run on which Turn" (that bookkeeping has no equivalent need for Custom Prompts, which don't suppress themselves the same way).

Also decide and implement what a Custom Prompt call writes to the **Research Eval Log**: today's log has no enforced schema per entry (it's an append-only JSON-lines file, whatever fields the caller passes get written) — this is a judgement call, not a rigid contract someone else already decided. At minimum, log enough to reconstruct what happened: the Custom Prompt's id/title, the resolved Placeholders it actually referenced, the raw reply, and latency — matching the rough level of detail the old Turn Actions used to log. Finally, update `CONTEXT.md`'s **Research Eval Log** entry (still describes the old Focus Turn/Grounding fields) to describe what's actually logged now.

**Where to look:** search the codebase for the fixed mode rules, the suppression/scoring functions, the enforced response schema, the fixed Turn Action id list, the Focus/Grounding window builder, and the "which actions already ran on this Turn" tracking — these are exactly the surface area this ticket removes or repoints. Some of that tracking wiring sits between the tab-strip component and the research panel component; confirm nothing else still calls it (ticket 06 should already have moved the Transcript facet off of it) before deleting.

**Blocked by:** 05, 06 (both must be fully working first — this ticket has nothing to fall back on if it turns out something still depended on the old path).

**Status:** ready-for-agent

- [ ] No code path can produce a Definition/Facts/Answer-shaped result any more.
- [ ] Full test suite is green after removal — obsolete tests are deleted, not skipped or left failing.
- [ ] A Custom Prompt call writes a Research Eval Log entry when logging is enabled, with a documented field set.
- [ ] `CONTEXT.md`'s Research Eval Log entry (and Transcript Activity entry, if ticket 06 didn't already fix it) match reality — no remaining mentions of Focus Turn, Grounding, or a "Transcript Tab pill" as if they still exist.
