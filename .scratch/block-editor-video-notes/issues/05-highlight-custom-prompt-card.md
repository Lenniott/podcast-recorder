# 05 — Highlight → Custom Prompt → Card Annotation

**Read first:** `docs/adr/0008-...md` in full — this is the ticket that actually delivers the thing the whole redesign exists for: reaching an AI lookup from wherever the host actually is (the video/Notes tab) without switching to a separate Transcript view, and doing it with the interpretation risk the design session tested and rejected (see the ADR's rationale — a fixed built-in lookup mode, given a whole lyric as context, leaked thematic interpretation the hosts hadn't discussed on air yet; that's exactly why this became "the host writes their own prompt" instead of "the product hardcodes a grounding policy").

**What to build:** Extend the same selection popup from ticket 03 to also list every configured Custom Prompt (from ticket 02) as its own one-click button, alongside Comment. Clicking one **fires immediately — no compose/typing step**. It resolves `{selection}` to the highlighted excerpt (and any other Placeholders the prompt's own text references) and calls the Research Assistant exactly the way today's existing "run a saved prompt against context" call already works — this ticket needs a new way to *build* that request (a specific Custom Prompt id + a specific highlighted excerpt, instead of always the one global prompt + the whole active tab), not a new way to *call* the LLM. The result becomes a Card Annotation (`kind:'card'`) in the same shared Annotation list Comments already appear in from ticket 03.

**Message shape to use** (mirrors `research_ask`/`research_resolve`/`research_error` — this path *does* need the pending/resolve round trip ticket 03's Comment didn't, because the answer isn't known until the Research Assistant responds):
- `annotation_ask` (client→server): `{type:'annotation_ask', tabId, id, kind:'card', customPromptId, quote, ...resolved-placeholder-context}`. Server creates a pending Annotation, broadcasts it via `annotation_entry`, computes the answer asynchronously (reusing the existing Research Assistant call, not a new LLM integration), then broadcasts the resolved `annotation_entry` — or an `annotation_error` on failure, mirroring how `research_error` works today.

**Gating:** Apply Guest Research Access exactly as Ask and the old Custom action already do — reuse the existing check, don't write a new one.

**Where to look:** the existing "build a request for the saved prompt against the active tab + transcript" function is the direct ancestor of what this ticket generalizes — find it alongside the Custom-request-building code from before ticket 02's rework, and adapt it to take a specific Custom Prompt id plus a resolved `{selection}` instead of always assuming the one global prompt and the whole tab.

**Blocked by:** 03 (needs the popup + Annotation stack) and 02 (needs the Custom Prompt list + placeholder engine).

**Hands off to the next ticket:** Ticket 06 needs this exact trigger flow to also work when the highlighted content is a Transcript Turn instead of Notes text. In your commit/PR, say explicitly whether your implementation of "resolve `{selection}` from the current highlight" is already surface-agnostic (works from any DOM selection, regardless of which component it's inside) or specific to the `contenteditable` Notes element — this materially changes how much work is left for ticket 06.

**Status:** ready-for-agent

- [ ] Every configured Custom Prompt appears as a one-click button in the selection popup.
- [ ] Clicking one fires immediately with no additional input step.
- [ ] `{selection}` resolves to exactly the highlighted text in the outgoing request; other Placeholders the prompt references resolve too.
- [ ] The result appears as a Card in the same panel list Comments appear in, visibly distinguishable as AI-authored vs. human-authored.
- [ ] A participant without Guest Research Access cannot trigger a Custom Prompt from a highlight (matches today's Ask/Custom gating exactly).
- [ ] Verify the spoiler-risk lesson directly: a Custom Prompt written to reference only `{selection}` (no `{transcript}`/`{current_tab}`) never receives anything beyond the highlighted excerpt in its request.
