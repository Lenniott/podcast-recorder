# Selection-anchored Annotations and user-authored Custom Prompts, replacing the Transcript Tab and fixed Turn Actions

Note: this is the first ADR in this repo to actually exist as a file. ADR-0002 through ADR-0007 are referenced from code comments but were never written down as files — only this decision going forward gets one.

Hosts needed the Research Assistant reachable from wherever they actually are — the video/Notes tab — without switching to the Transcript Tab, and needed control over what context and interpretation a lookup applies: a direct test showed the built-in Definition mode, given a whole lyric as Grounding, leaking thematic/symbolic interpretation of song lyrics before the hosts had discussed them on air, which this show can't tolerate. We decided: Notes' `<textarea>` becomes `contenteditable` so any highlighted span of Notes text or a Transcript Turn can be annotated in place; **Comment** (human) and **Card** (AI) collapse into one **Annotation** concept, anchored by a frozen quote rather than a live position, so a stale anchor never lies about where it points; the Transcript Tab is retired as a main-stage Tab and becomes a personal, local facet of the right panel instead, since it's a reference surface you dip into, not a place you sit; and the fixed Definition/Facts/Answer Turn Actions (with their hardcoded MODE_RULES and provenInTranscript/ubiquitousKnowledge suppression scoring) are retired in favor of a deployment-wide list of user-authored **Custom Prompts**, each built from an expanded Placeholder library (`{selection}`, `{video_title}`, `{current_time}`, `{latest_transcript}`, plus the existing `{current_tab}`/`{transcript}`) — putting control of grounding and interpretation directly in the host's own prompt text instead of one hardcoded policy for every show.

## Considered options

- **Kept Definition/Facts/Answer as fixed built-ins, added Custom Prompts alongside.** Rejected — doubles the actions surface to maintain, and doesn't remove the interpretation problem for whichever modes stay fixed.
- **Scoped Grounding to "prior text only" instead of retiring the fixed modes.** A real fix for the spoiler case specifically, but still one hardcoded policy for every show; a user-authored prompt is strictly more flexible, so this was folded into "the host writes their own rule" instead of becoming a new hardcoded rule.
- **Per-room Custom Prompt authoring, editable by a room's Host mid-show.** Rejected for now — no stated need justifies the added per-room authoring/permission surface; kept at today's site-password-gated, deployment-wide scope.
- **A live transcript strip embedded in the Notes/video tab, and later a fully merged Notes+Transcript view.** Both rejected in favor of Transcript as a panel facet — cheaper (reuses `RoomTabs`' existing live `transcriptLines` state without reshaping the main-stage layout) and keeps the main stage (video + Notes) visually stable.
- **Whole-line selection instead of arbitrary text selection.** Rejected — arbitrary selection was preferred for precision, at the accepted cost of the `contenteditable` migration.
- **Custom Prompts pause for a typed follow-up question at invocation time** (like typed Ask). Rejected — every Custom Prompt fires immediately, fully self-contained from its saved template; open-endedness is something the prompt's author writes into the template, not a runtime step.

## Consequences

- Notes' `<textarea>` → `contenteditable` migration is real, unavoidable work, not a styling change.
- The existing Turn Action structured-output path (`research-card.js`'s suppression/mode-matching, the `research_card` JSON schema, `TURN_ACTION_ID_SET`) becomes dead code to remove, along with any tests targeting it.
- `ResearchPromptEditor.svelte` and its save action move from a single `{title, prompt}` pair to a managed list.
