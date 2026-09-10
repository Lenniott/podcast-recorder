# 03 — Render blocks as real UI instead of raw text

**Read first:** tickets 01–02 (what a structured Annotation's stored shape looks like — ticket 02's own "Hands off" section states the exact `entry.blocks` shape and the `entry.text`-is-never-blocks-only guarantee), `ResearchPanel.svelte`'s existing Annotation-list markup (the `.annotation`/`.annotation-text` block) and research-entries markup (`.research-interpretation`/`.research-card`/`.research-answer`) — both currently render a plain string with no formatting. Also read the commit that added panel-button Custom Prompts (`git log --oneline` on this branch for "split Custom Prompts between the highlight popup and standalone panel buttons," landed after ticket 02) — it added a SECOND way a Custom Prompt's result reaches the research-entries list (not just typed Ask), which changes this ticket's scope; see the note below.

**What to build:** A small renderer, keyed on each block's `type`, producing real markup instead of text a reader has to parse themselves:
- `paragraph` → a plain `<p>`.
- `list` → a real `<ul><li>` per item.
- `stat` → a small labeled callout (label + value, styled distinctly — see how `.annotation-badge`/`.annotation-card` already give a Card visual weight distinct from a Comment, for the level of visual treatment to aim for; don't over-design a whole new visual language for one block type).

**Where `blocks` actually lives today (resolved — don't re-derive this):**
- **Annotations** (`room-state-store.js`'s `addAnnotation`/`resolveAnnotation`/`errorAnnotation`) carry `entry.blocks` since ticket 02 — `null` for a Comment, a `'text'`-format Card, or a pre-ticket-02 Card; a sanitized Block array for an answered `'blocks'`-format Card with something to report.
- **Research entries** (`room-state-store.js`'s `addResearchEntry`/`resolveResearchEntry`/`errorResearchEntry` — used by BOTH typed Ask, client-driven via `research_ask`/`research_resolve`, AND the newer panel-button Custom Prompt path, server-resolved via `research_prompt_ask`/`runResearchPromptAsk` in `ws-rooms.js`) have **no `blocks` field at all**. A "Structured blocks"-format Custom Prompt run from a panel button (a template that does not reference `{selection}` — see `db.js`'s `listCustomPromptSummaries`/`usesSelection`) today produces a research entry whose only content is the flattened-text fallback in `entry.answer` — there is nothing to render as Blocks for it yet, by design of that earlier feature, which explicitly left this out of its own scope for ticket 03 to pick up.

**This ticket therefore has two parts, not one:**
1. **Render** — the renderer described above, wired into the Annotation list (reading `annotation.blocks`) exactly as originally scoped.
2. **Extend research entries to carry `blocks` too**, mirroring ticket 02's own Annotation work exactly, so a panel-triggered "Structured blocks" prompt has something to render:
   - `addResearchEntry`: initialize `blocks: null` on a new entry (mirrors `addAnnotation`).
   - `resolveResearchEntry(slug, entryId, { answer, citations, blocks })`: accept `blocks`, re-sanitize via `research/research-blocks.js`'s `sanitizeBlockList` (never trust it as already clean — same discipline `resolveAnnotation` uses).
   - `errorResearchEntry`: reset `blocks: null` (mirrors `errorAnnotation`).
   - `ws-rooms.js`'s `runResearchPromptAsk`: pass `askResearchAssistant`'s `blocks` return value through to `resolveResearchEntry` (it already destructures `{ answer, citations }` — add `blocks`). The client-driven `research_resolve` handler (typed Ask) can pass `msg.blocks` through the same way for consistency, even though typed Ask itself never produces one today (it's always a `kind: 'voice'` request) — harmless, and keeps the two entry-producing paths from silently diverging in shape.
   - Wire the renderer into the research-entries list (reading `entry.blocks`) the same way as the Annotation list.

Do not skip part 2 and call this ticket done with only Annotations rendering Blocks — that would leave the already-shipped panel-button feature's own "Structured blocks" option silently non-functional (it would validate, save, and run, and then never show anything but flattened text), which is a worse outcome than not having built part 2 of the panel-button feature at all.

**The fallback path matters as much as the new one:** every Annotation and research entry that predates this feature (which is all of them, on any real deployment) has no `blocks` field at all — and any Custom Prompt still set to `'text'` format never will. Rendering must check for `blocks` and only take the new path when it's actually present and non-empty; everything else keeps rendering exactly as it does today, unchanged. Do not make `blocks`-checking the only path and lose today's plain-text rendering as a side effect.

**Blocked by:** 02.

**Hands off to the next ticket (04, e2e coverage):** state plainly, in your commit message and here in this file, the exact CSS classes/`data-testid` attributes each block type's rendered markup uses (in both the Annotation list and the research-entries list), and confirm whether an old-style plain-text Card/entry's existing DOM structure is unchanged by this ticket (it must be) — ticket 04 needs both to write stable Playwright locators without re-reading this ticket's diff itself.

**Status:** ready-for-agent

- [ ] Each of the three block types (`paragraph`, `list`, `stat`) renders as real, distinct markup — no literal `**`/`*`/`#` characters visible anywhere.
- [ ] A structured Custom Prompt's result is visually distinguishable as *structured* (e.g., a real bulleted list actually looks like a list), verified against a real or realistically mocked reply.
- [ ] This is true in BOTH surfaces: a Card (Annotation list, highlight-triggered) AND a research entry (research-entries list, panel-button-triggered) — see "Where `blocks` actually lives today" above for why the second surface needs its own storage plumbing, not just a renderer.
- [ ] Every existing Comment, freeform Card, and typed-Ask research entry — anything with no `blocks`, structured-format or not — renders exactly as it did before this ticket. This is the one acceptance criterion worth manually spot-checking rather than trusting a unit test alone: run the app, look at an old-style card next to a new structured one.
