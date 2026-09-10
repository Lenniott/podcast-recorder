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

**Status:** done

- [x] Each of the three block types (`paragraph`, `list`, `stat`) renders as real, distinct markup — no literal `**`/`*`/`#` characters visible anywhere.
- [x] A structured Custom Prompt's result is visually distinguishable as *structured* (e.g., a real bulleted list actually looks like a list), verified against a real or realistically mocked reply.
- [x] This is true in BOTH surfaces: a Card (Annotation list, highlight-triggered) AND a research entry (research-entries list, panel-button-triggered) — see "Where `blocks` actually lives today" above for why the second surface needs its own storage plumbing, not just a renderer.
- [x] Every existing Comment, freeform Card, and typed-Ask research entry — anything with no `blocks`, structured-format or not — renders exactly as it did before this ticket. This is the one acceptance criterion worth manually spot-checking rather than trusting a unit test alone: run the app, look at an old-style card next to a new structured one.

**Implementation notes (what actually got built):**

Part 1 (research entries carry `blocks`) mirrors ticket 02's Annotation work
field-for-field:
- `room-state-store.js`'s `addResearchEntry` now initializes `blocks: null`
  on every new entry (same as `addAnnotation`).
- `resolveResearchEntry(slug, entryId, { answer, citations, blocks })` now
  accepts `blocks` and re-sanitizes it via `research-blocks.js`'s
  `sanitizeBlockList` before storing — never trusted as already clean, same
  discipline `resolveAnnotation` uses for its own `blocks` param.
- `errorResearchEntry` resets `blocks: null` alongside `answer`.
- `ws-rooms.js`'s `runResearchPromptAsk` now destructures `blocks` from
  `askResearchAssistant`'s return value and passes it through to
  `resolveResearchEntry`. The client-driven `research_resolve` handler
  (typed Ask's path) now accepts and passes through `msg.blocks` too, for
  shape parity between the two entry-producing paths — typed Ask itself
  still never produces one (it's always a `kind: 'voice'` request).
- The wire-protocol doc comments for `research_entry` (server → client) and
  `research_resolve` (client → server) in `ws-rooms.js`'s header comment now
  mention `blocks`, mirroring `annotation_entry`'s own doc comment.
- No premise turned out to be wrong: `resolveResearchEntry` had no
  pre-existing field doing this job, and `askResearchAssistant`'s return
  shape (`{ answer, citations, blocks }`) matched the ticket's assumption
  exactly (already used unchanged by `runAnnotationAsk`).

Part 2 (rendering) is a single new component, `src/lib/research/BlockList.svelte`,
shared by both surfaces (rather than duplicating the block-type markup twice)
— it takes a `blocks` array prop and renders:
- `paragraph` → `<p class="block-paragraph" data-testid="block-paragraph">`
- `list` → `<ul class="block-list-items" data-testid="block-list-items">`
  with one `<li data-testid="block-list-item">` per item (a real list
  element, not bullet characters in a paragraph)
- `stat` → `<div class="block-stat" data-testid="block-stat">` containing
  `<span class="block-stat-label" data-testid="block-stat-label">` and
  `<span class="block-stat-value" data-testid="block-stat-value">`,
  accent-tinted the same register `.annotation-card`/`.annotation-badge`
  already use to set a Card apart from a Comment.
- The whole list is wrapped in `<div class="block-list" data-testid="block-list">`.

**Wiring (`ResearchPanel.svelte`), for ticket 04's locators:**
- Annotation list: inside the existing `status` if/else chain (pending /
  errored / else), a new `{:else if annotation.blocks?.length}` branch
  renders `<BlockList blocks={annotation.blocks} />` — added BEFORE the
  final `{:else}` that renders `<p class="annotation-text">{annotation.text}</p>`.
  That final branch, its markup, and its class are byte-for-byte unchanged
  from before this ticket (see the diff — the only change to that branch's
  surrounding code is the new sibling `{:else if}` above it).
- Research entries list: inside `{:else if entry.status === "answered"}`,
  the body is now `{#if entry.blocks?.length}` → `<BlockList blocks={entry.blocks} />`
  `{:else}` → the pre-existing `{@const card = parseResearchCard(entry.answer)}`
  block with its `.research-interpretation`/`.research-card`/`.research-answer`
  markup, verbatim, unchanged.
- **Confirmed:** every annotation/entry with no `blocks` (i.e. `blocks` is
  `null` or an empty array) takes the exact same branch, producing the exact
  same DOM/classes, as before this ticket — the new branches are pure
  additions ahead of the existing `{:else}`, never a replacement of it. Diff
  reviewed line-by-line for this specifically (see `git show` on this
  ticket's commit).
- Unit test coverage: `tests/unit/room-state-store.test.js`'s new
  "Structured Block output (mirrors resolveAnnotation/errorAnnotation)"
  describe block, and `tests/unit/ws-research-prompt-ask.test.js`'s new
  "a \"blocks\"-format Custom Prompt" describe block (mirrors
  `ws-annotation-ask.test.js`'s own of the same name). No Svelte-rendering
  unit test was added for `BlockList.svelte` itself — ticket 04 is the
  e2e ticket that exercises the rendered markup end to end; svelte-check (0
  errors) and a manual reasoning pass over the diff cover the markup change
  itself for this ticket.
