# 04 — e2e coverage: panel-button Custom Prompts and Block rendering

**Read first:**
- `AGENTS.md` in full, before anything else — its "never let the UI claim things are fine when they might not be" rule is exactly what this ticket exists to backstop: unit tests already cover the wire protocol and the storage/sanitizing logic for everything below, but nothing exercises any of it through a real browser, so a UI-level regression (a renamed CSS selector, a Svelte reactivity bug that only shows up on a real re-render, a click that silently stops reaching its handler) currently has no test that would catch it.
- Ticket 03 (Block rendering) — read its own "Hands off to the next ticket (04)" note for the exact CSS classes/`data-testid` attributes each block type renders with in both surfaces, and its confirmation that old-style plain-text rendering is unchanged. Do not re-derive these from the diff yourself if that note states them plainly.
- The panel-button Custom Prompts feature (`git log --oneline` on this branch for "split Custom Prompts between the highlight popup and standalone panel buttons") — read `src/lib/research/research-panel.js`'s `panelPromptButtons`, `src/lib/room/selection-annotations.js`'s `customPromptActions`, and `src/lib/server/ws-rooms.js`'s `research_prompt_ask`/`annotation_ask` handlers for what each surface actually does.
- `tests/playwright/research_panel.spec.js` and `tests/playwright/helpers.js` for this repo's existing Playwright conventions — page-object-ish helpers for creating/joining a room, how a host vs. guest session is set up, existing locator style. Match it; do not invent a second style.
- `CONTEXT.md`'s **Custom Prompt**, **Card**, **Comment**, **Annotation**, and both **Block** entries for the vocabulary this spec's own comments and test names should use.

**Why this exists:** two real, already-shipped features (this line's whole structured-Block-output arc, and the panel-button/highlight-popup split) currently have zero end-to-end coverage. Both are UI-facing by nature — where a button appears, what a click produces, whether a reply actually *looks* structured to a viewer — which is precisely the class of bug a mocked-DOM unit test structurally cannot catch.

**What to build:** one or more Playwright specs (organize into files however this repo's existing convention suggests — check whether `research_panel.spec.js` is the natural home or a new file reads better given its current size) covering:

1. **Popup/panel placement is mutually exclusive.** A Custom Prompt whose template references `{selection}` appears ONLY in the highlight popup (highlight some Notes text, open the popup, see its button) and NEVER as a panel button. A Custom Prompt whose template does not reference `{selection}` appears ONLY as a panel button (visible without highlighting anything) and NEVER in the popup.
2. **Guest gating on a panel button.** With Guest Research Access off, a guest sees the panel button but it's disabled with an explanatory title; the host's own button for the same prompt is enabled and works. (Mirror whatever this repo's existing spec already does to prove the equivalent for the highlight-popup's own Custom Prompt buttons, if one exists — same assertions, different trigger surface.)
3. **A panel button produces a research entry.** Click it; a pending entry appears in the research-entries list; it resolves to answered; the prompt's title appears where a typed question normally would.
4. **Each Block type renders as real markup**, in BOTH surfaces (a Card in the Annotation list, from a highlight; a research entry, from a panel button): `paragraph` as a real `<p>`, `list` as a real `<ul><li>` (assert on the tag/role, not just visible text — a screen reader distinguishes a real list from a paragraph containing bullet characters, and so should this test), `stat` as its labeled callout. No literal `**`, `*`, or `#` visible anywhere in a structured reply.
5. **The pre-existing plain-text path is untouched.** An old-style "Freeform text" Custom Prompt's Card and a typed Ask's research entry render exactly as they did before ticket 03 — same DOM shape, no stray Block markup, no regression. This is the criterion most worth getting a real, specific assertion for rather than a loose "the panel didn't crash" check.

**Test-safety — read this before writing a single line, it is a standing, non-negotiable rule in this repo:** NOTHING in this suite may spend a real OpenRouter token, ever, including in CI or a re-run. This repo already backstops that at the `webServer` level (`playwright.config.js` blanks `OPENROUTER_API_KEY` for the dev server it spins up), but every existing spec that exercises a Research Assistant call ALSO intercepts the network call itself via `page.route()` and returns a mocked response — find that pattern in an existing spec (grep for `page.route` across `tests/playwright/`) and use it for both a plain-text mocked reply and a `{"blocks": [...]}` JSON mocked reply (the exact shape `research-blocks.js`'s schema produces — check `tests/unit/research-blocks.test.js` or `tests/unit/research-assistant.test.js`'s own mocked replies for the literal JSON shape to reuse, don't invent a new one). Before finishing, grep your own new spec file for anything that could reach a real network call and confirm every one is routed — this is the same audit already run once this session over the rest of the suite, and it must hold for whatever you add too.

**Practical note on running this locally in a sandbox:** per `AGENTS.md`, `npm run dev` (which `test:e2e` boots) needs a local `.env` with `SECRET` set — it does not exist by default and is gitignored, never committed. Create one (`echo "SECRET=whatever-local-value" > .env` is enough; nothing else in it needs a real value for this suite, since `OPENROUTER_API_KEY` is blanked by `playwright.config.js` regardless). If the sandboxed Chromium revision doesn't match the pinned `@playwright/test` version, `playwright.config.js`'s own comment explains the `executablePath` workaround for that one local run — don't commit that change.

**Blocked by:** 03.

**Status:** done

- [x] Popup/panel placement (item 1) is covered and passing.
- [x] Guest gating on a panel button (item 2) is covered and passing.
- [x] A panel-triggered prompt produces a visible, answered research entry (item 3).
- [x] Each of the three Block types renders as real markup in BOTH surfaces (item 4), with an assertion that would actually fail if a future change silently reverted to plain text (not just "the text is present somewhere").
- [x] The pre-existing plain-text path (item 5) has its own explicit, specific assertion — not just "no error was thrown."
- [x] The new spec(s) pass under `npm run test:e2e` and, on inspection, cannot reach a real OpenRouter call under any code path exercised.

**Implementation notes:**

New spec `tests/playwright/research_custom_prompts.spec.js`, 4 tests covering
all 5 items (guest gating and the entry-produced check share one test, since
proving the gate also requires proving the host's click actually works).
Helpers added to `tests/playwright/helpers.js`: `createCustomPrompt`/
`deleteCustomPrompt` (drive the real, site-password-gated Usage Dashboard UI
— never insert directly into the DB) and `mockCustomPromptOutcomes`.

**The one non-obvious piece, worth recording so nobody re-derives it the hard
way:** `annotation_ask` and `research_prompt_ask` are fully server-resolved
(ws-rooms.js) — there is no browser-visible HTTP request for `page.route()`
to intercept the way `mockResearchEndpoint` intercepts typed Ask's POST. The
actual, non-negotiable token-spend guard for those two paths is
`playwright.config.js`'s `webServer.env.OPENROUTER_API_KEY: ''`, which makes
`askResearchAssistant()` throw `NOT_CONFIGURED` before any network I/O, for
every request kind, every time. `mockCustomPromptOutcomes` uses
`page.routeWebSocket` to rewrite that already-harmlessly-failed outcome's WS
frame into a chosen "answered" one (text or `{blocks}`), so assertions can be
specific and deterministic without ever touching a real key or a real
network call.

**A real ordering bug this surfaced and fixed:** `page.routeWebSocket` only
intercepts WebSocket connections opened *after* it's registered — never
retroactively. The first draft of this spec called `mockCustomPromptOutcomes`
*after* `createRoom`/`joinAsGuest`, which had already opened the room's
socket; the mock silently never applied, so the entry received the real
(unmocked) `NOT_CONFIGURED` error and stayed `errored` instead of moving to
`answered` — 3 of 4 tests failed on this before the fix. It must be
registered right after `stubYouTubeApi(page)`, before any `createRoom`/
`joinAsGuest` call on that page. Verified fixed: a full clean single-instance
`npx playwright test tests/playwright/research_custom_prompts.spec.js` run
(4/4 passing) and a full `npm run test:e2e` run (59 passed, 1 pre-existing
unrelated skip, 0 failures, including this file's 4 tests at their real
position in the suite).

Note for whoever runs this next in a sandboxed container: `npm run test:e2e`
needs a local `.env` with `SECRET` set (gitignored, never committed) and, if
the sandbox's Chromium revision doesn't match the pinned `@playwright/test`
version, a temporary local-only `executablePath: '/opt/pw-browsers/chromium'`
in `playwright.config.js`'s `launchOptions` — never commit that change.
