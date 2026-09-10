# 02 — Per-Custom-Prompt output format, wired into the real trigger path

**Read first:** ticket 01 (the schema and request-level mechanism this wires up) and `CustomPromptListEditor.svelte`/`custom-prompts.js` for the existing per-prompt editor and validation conventions.

**What to build:**
1. Add an `output_format` column to the `custom_prompts` table (`db.js`) — `'text'` default, so every existing prompt keeps behaving exactly as it does today with zero migration risk. Follow the same schema-evolution pattern already used for this table (see `db.js`'s comment on migrating the retired single Research Prompt into this table, and its own `CREATE TABLE`/migration style).
2. Add a toggle to the Custom Prompt editor (`CustomPromptListEditor.svelte`) — "Freeform text" vs. "Structured blocks" (naming up to you, keep it short enough to fit the existing row layout) — on both the new-prompt form and the edit-row form. Persist it through `create_custom_prompt`/`update_custom_prompt` (`+page.server.js`'s actions) same as title/prompt already are.
3. Wire it into the real trigger path: `ws-rooms.js`'s `runAnnotationAsk` currently always reads `parseResearchCard(answer)?.mainTakeaway` as the Card's text. When the triggering Custom Prompt's `output_format` is `'blocks'`, it should instead request ticket 01's structured path and store the returned `blocks` on the Annotation via `resolveAnnotation` (`room-state-store.js`) — extend that function's accepted fields the same deliberate way `text`/`citations` are handled there now (validated, bounded, never trusted raw off the wire beyond what's already checked).
4. `getCustomPrompt`/`listCustomPrompts` (`db.js`) need to return `output_format` so `runAnnotationAsk` can read it — check every existing caller of those functions doesn't choke on an unexpected extra field.

**Deliberately not doing:** no rendering here — a structured Annotation's `blocks` will sit unrendered in the panel until ticket 03 lands (the panel's existing fallback path, reading `annotation.text`, will simply show nothing or something empty-looking for a blocks-only Annotation in the meantime — that's expected and temporary, not a bug to chase in this ticket).

**Blocked by:** 01.

**Hands off to the next ticket:** Ticket 03 needs the exact field name and shape of `blocks` as stored on an Annotation (from `resolveAnnotation`'s stored `entry`) and needs to know whether a structured Annotation still carries a non-empty `entry.text` fallback (useful for anywhere — Eval Log, a future export — that only knows how to read plain text) or `blocks`-only. State this explicitly.

**Status:** ready-for-agent

- [ ] `output_format` persists per Custom Prompt, defaults to `'text'` for every prompt that existed before this ticket.
- [ ] The editor lets a host choose the format when creating or editing a prompt.
- [ ] Triggering a `'blocks'`-format prompt from a highlight produces an Annotation whose stored shape actually contains a `blocks` array (verifiable via the stored room state / Eval Log, even with no renderer yet).
- [ ] Triggering a `'text'`-format prompt is completely unaffected — byte-identical behavior to before this ticket.
