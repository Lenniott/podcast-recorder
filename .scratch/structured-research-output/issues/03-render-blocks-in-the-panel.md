# 03 — Render blocks as real UI instead of raw text

**Read first:** tickets 01–02 (what a structured Annotation's stored shape looks like) and `ResearchPanel.svelte`'s existing Annotation-list markup (the `.annotation`/`.annotation-text` block) and research-entries markup (`.research-interpretation`/`.research-card`/`.research-answer`) — both currently render a plain string with no formatting.

**What to build:** A small renderer, keyed on each block's `type`, producing real markup instead of text a reader has to parse themselves:
- `paragraph` → a plain `<p>`.
- `list` → a real `<ul><li>` per item.
- `stat` → a small labeled callout (label + value, styled distinctly — see how `.annotation-badge`/`.annotation-card` already give a Card visual weight distinct from a Comment, for the level of visual treatment to aim for; don't over-design a whole new visual language for one block type).

Wire it into **both** places an Annotation's body can render — the unified Annotation list ADR-0008 tickets 03/05 built, and the older `entries`/research-entries list (`.research-answer`/`.research-interpretation`) that typed Ask still uses — a structured Custom Prompt result can in principle surface through either path depending on how tickets 01/02 ended up threading it through, so check which one(s) actually carry `blocks` before assuming just one needs touching.

**The fallback path matters as much as the new one:** every Annotation and research entry that predates this feature (which is all of them, on any real deployment) has no `blocks` field at all — and any Custom Prompt still set to `'text'` format never will. Rendering must check for `blocks` and only take the new path when it's actually present and non-empty; everything else keeps rendering exactly as it does today, unchanged. Do not make `blocks`-checking the only path and lose today's plain-text rendering as a side effect.

**Blocked by:** 02.

**Status:** ready-for-agent

- [ ] Each of the three block types (`paragraph`, `list`, `stat`) renders as real, distinct markup — no literal `**`/`*`/`#` characters visible anywhere.
- [ ] A structured Custom Prompt's result is visually distinguishable as *structured* (e.g., a real bulleted list actually looks like a list), verified against a real or realistically mocked reply.
- [ ] Every existing Comment, freeform Card, and typed-Ask research entry — anything with no `blocks`, structured-format or not — renders exactly as it did before this ticket. This is the one acceptance criterion worth manually spot-checking rather than trusting a unit test alone: run the app, look at an old-style card next to a new structured one.
