# 01 — Define the Block schema; a request can ask for structured output

**Read first:** this file's sibling tickets (02, 03) for the full arc, and this session's conversation where the idea originated — a live Custom Prompt reply came back as raw markdown (`**bold**`, `*` bullets, bracket citation stubs) that nothing in the UI renders, patched reactively with a text-cleanup regex (`stripUnrenderedMarkup` in `research-card.js`). This ticket line is the proactive fix: instead of cleaning up prose after the fact, let a Custom Prompt ask the model for a small set of typed, renderable containers instead of free text, and use `response_format: { type: 'json_schema', strict: true }` to make that a guarantee rather than a request.

**Important correction to keep in mind while building this:** you do **not** need a "validate the JSON, retry against the model if wrong" loop. OpenRouter's `strict: true` JSON-schema mode is constrained decoding — the model cannot emit output that fails to match the schema, full stop. This exact mechanism already existed in this codebase (`researchCardSchema` in `research-assistant.js`, removed by ADR-0008 ticket 07 along with the fixed Turn Actions it served) — you're bringing back the *mechanism*, not the thing that made the old use of it a problem. That's worth being precise about: the old schema was risky because it constrained *content* (forced scoring fields, a system prompt dictating interpretation). A block-shape schema only constrains *presentation* — which typed container to put text in — while the host's own freeform prompt text still controls everything about what's actually said. Different axis, not a reversion.

**What to build:**
1. A small block vocabulary (start minimal, extend later if real usage shows a gap — do not over-design this up front):
   - `{ type: 'paragraph', text: string }`
   - `{ type: 'list', items: string[] }`
   - `{ type: 'stat', label: string, value: string }`
   These three cover every shape seen in the real replies that prompted this (a verdict statement, a bulleted key-facts list, a highlighted percentage/number).
2. A schema (`{ blocks: [...] }`, `strict: true`) built the same way `researchCardSchema` used to be — check ADR-0008/ticket 07's diff (`git log`) for exactly what that looked like before removal; the shape-definition mechanics are the same, only the fields differ.
3. A new field on the `custom` request (`buildCustomPromptRequest` / `askResearchAssistant` in `research-assistant.js`) — e.g. `outputFormat: 'text' | 'blocks'` — that decides whether `buildRequestBody` attaches the schema and `response_format`. Default stays `'text'` (today's freeform behavior) — nothing existing changes shape.
4. When `outputFormat === 'blocks'`, `askResearchAssistant`'s return value carries the parsed `blocks` array alongside (or instead of) today's flat `answer` string — decide which based on what ticket 02's caller (`runAnnotationAsk` in `ws-rooms.js`) and the Eval Log both need; the Eval Log likely still wants *something* readable in its existing `raw`/`card` fields, so carrying both is probably simplest.
5. An empty `blocks: []` from the model means "nothing to report" — same convention as an empty `mainTakeaway` today (see `parseResearchCard`'s `normalizeEmptyCard`).

**Deliberately out of scope for this ticket (and probably this whole line, unless a real need shows up):**
- Citations stay exactly as they are today — a separate `citations` array rendered below the card, never folded into a block type. Don't relitigate this without a concrete reason.
- No `{:else}`-equivalent, no nested blocks, no block-level styling/metadata (color, icon) — three flat types, nothing more.
- No UI rendering yet — that's ticket 03. This ticket is verified through tests on the request/response shape alone, the same way ADR-0008 ticket 02 (Custom Prompt list + placeholders) shipped its substitution engine before anything triggered it from a highlight.

**Where to look:** `research-assistant.js`'s `buildRequestBody`/`askResearchAssistant`/`buildCustomPromptRequest`, and `research-card.js`'s `sanitizeResearchCard`/`parseResearchCard`/`serializeResearchCard` for the existing card-shape conventions (empty-means-nothing, `MODES` allowlist) to stay consistent with.

**Blocked by:** None — can start immediately. Pure backend/schema work.

**Hands off to the next ticket:** Ticket 02 needs to know exactly what field name carries the output-format choice on a request, and exactly what shape `askResearchAssistant` returns when it's `'blocks'` (a `blocks` array key, its exact location in the return value) — state this plainly in your commit/PR.

**Status:** done

- [x] The three block types are defined and schema-validated end to end against a real (or realistically mocked) OpenRouter `strict: true` response.
- [x] A `'text'`-format request is completely unaffected — same request shape, same response shape as today.
- [x] A `'blocks'`-format request attaches the schema and returns a parsed `blocks` array.
- [x] An empty `blocks: []` reply is treated as "nothing to report," consistent with today's empty-`mainTakeaway` convention.
- [x] Unit tests cover both format paths, mirroring the rigor of `research-assistant.test.js`'s existing `buildCustomPromptRequest` suite.

**Implementation notes for ticket 02 (exact field names/shapes to build on):**
- The schema/parse/flatten module is `src/lib/research/research-blocks.js` —
  `blocksResponseSchema()`, `parseBlocks(raw)`, `flattenBlocksToText(blocks)`.
- `buildCustomPromptRequest({..., outputFormat = 'text'})` — pass
  `outputFormat: 'blocks'` to request structured output on a `custom`
  request. Anything other than the literal string `'blocks'` normalizes to
  `'text'`. The returned request object carries this back as
  `request.outputFormat`.
- `askResearchAssistant(request, opts)` returns `{ answer, citations, blocks }`.
  `blocks` is a real (non-empty) array only when `request.kind === 'custom'`
  and `request.outputFormat === 'blocks'` and the model's reply had
  something to report; it is `null` for every other case, including a
  blocks-format request whose reply was empty/unparseable. `answer` is
  always the existing serialized-card JSON string (`JSON.parse(answer).mainTakeaway`
  to read it) — for a blocks-format request this is a flattened-text
  fallback (`flattenBlocksToText`) instead of raw model prose, and is `''`
  when `blocks` is `null`, matching the existing empty-`mainTakeaway`
  convention. `runAnnotationAsk` (ws-rooms.js) can therefore keep reading
  `answer` unchanged for a `'text'` prompt, and read `result.blocks` for a
  `'blocks'` one — ticket 02 is what decides which prompts pass
  `outputFormat: 'blocks'` in the first place.
