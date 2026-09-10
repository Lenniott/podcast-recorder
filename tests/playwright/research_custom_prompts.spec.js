import { test, expect } from '@playwright/test'
import {
  stubYouTubeApi,
  createRoom,
  joinAsGuest,
  mockResearchEndpoint,
  createCustomPrompt,
  deleteCustomPrompt,
  mockCustomPromptOutcomes
} from './helpers.js'

/**
 * e2e coverage for two already-shipped, previously-untested features
 * (structured-research-output ticket 04):
 *
 *   1. The highlight-popup / standalone-panel-button split for Custom
 *      Prompts (git log: "split Custom Prompts between the highlight popup
 *      and standalone panel buttons") — a prompt referencing `{selection}`
 *      belongs only in the popup, one that doesn't belongs only in the
 *      panel, never both, never neither (selection-annotations.js's
 *      customPromptActions / research-panel.js's panelPromptButtons).
 *   2. Structured Block rendering (ticket 03) in both the surfaces a
 *      Custom Prompt's answer can land in — a Card in the Annotation list,
 *      or a research entry in the research-entries list — plus proof the
 *      pre-existing plain-text rendering in both is untouched.
 *
 * Vocabulary follows CONTEXT.md's Custom Prompt / Card / Comment /
 * Annotation / Block entries: a Card is the Research-Assistant-authored
 * half of the shared Annotation list; a research entry is what a typed Ask
 * or a panel-button Custom Prompt files under the active tab.
 *
 * TEST SAFETY — see mockCustomPromptOutcomes' own doc comment in
 * helpers.js for the full reasoning. Short version: annotation_ask and
 * research_prompt_ask run their Research Assistant call entirely inside
 * the separate dev-server process Playwright's webServer spawns, with no
 * browser-visible HTTP request for page.route() to intercept — the actual
 * guard against a real OpenRouter call on those two paths is
 * playwright.config.js blanking OPENROUTER_API_KEY, which makes
 * askResearchAssistant() throw NOT_CONFIGURED before any network I/O.
 * mockCustomPromptOutcomes only rewrites the WS frame carrying that
 * already-harmlessly-failed outcome into a chosen "answered" one, so this
 * file's Block-rendering assertions can be specific and deterministic.
 * Every other call this file makes (typed Ask) goes through
 * mockResearchEndpoint, which — like every existing spec that uses it —
 * intercepts the browser's own POST before it ever reaches the dev server.
 */

const notesOf = (page) =>
  page.getByRole('textbox', { name: 'Shared notes — visible to everyone in the room…' })

/** Highlights `phrase` inside the Notes surface — mirrors
 *  annotation_highlight.spec.js's own helper of the same name; duplicated
 *  rather than imported since it isn't exported there either (each
 *  highlight-driving spec builds its own live Selection). */
async function selectInNotes(page, phrase) {
  const found = await page.evaluate((needle) => {
    const el = document.querySelector('[data-notes-editor]')
    if (!el) return false
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode())) {
      const index = node.textContent.indexOf(needle)
      if (index === -1) continue
      const range = document.createRange()
      range.setStart(node, index)
      range.setEnd(node, index + needle.length)
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      return true
    }
    return false
  }, phrase)
  expect(found).toBe(true)
}

const popup = (page) => page.locator('[data-testid="selection-popup"]')
const popupPromptButton = (page, title) => popup(page).getByRole('button', { name: `Run ${title} on the highlighted text` })
const panelPromptButton = (page, title) => page.locator('.panel-prompt-btn', { hasText: title })

// A short, unique-enough label per run — Custom Prompts are global,
// persistent config (not room-scoped), so a fixed title would collide
// across repeated local runs against the same gitignored e2e-rooms.db.
// Kept under CUSTOM_PROMPT_TITLE_MAX_LENGTH (40 chars).
const suffix = () => String(Date.now()).slice(-6) + String(Math.floor(Math.random() * 1000))

const SAMPLE_BLOCKS = [
  { type: 'paragraph', text: 'Straight prose, no markdown syntax in it.' },
  { type: 'list', items: ['First point', 'Second point'] },
  { type: 'stat', label: 'Runtime', value: '42 minutes' }
]

test('a {selection} Custom Prompt appears only in the popup; a non-{selection} one appears only as a panel button', async ({ page }) => {
  await stubYouTubeApi(page)

  const selectionTitle = await createCustomPrompt(page, {
    title: `Sel ${suffix()}`,
    prompt: 'Summarize this: {selection}',
    outputFormat: 'text'
  })
  const panelTitle = await createCustomPrompt(page, {
    title: `Panel ${suffix()}`,
    prompt: 'Say one fun fact about podcasting.',
    outputFormat: 'text'
  })

  await createRoom(page, { name: `E2E CustomPromptPlacement ${Date.now()}`, password: 'custom-prompt-placement' })

  // The non-{selection} prompt is a standalone panel button, visible with
  // no highlight at all. The {selection} one must NOT be one.
  await expect(panelPromptButton(page, panelTitle)).toBeVisible()
  await expect(page.locator('.panel-prompt-btn', { hasText: selectionTitle })).toHaveCount(0)

  // Highlighting text opens the popup. The {selection} prompt belongs
  // there; the panel-only prompt must NOT also show up in it.
  await notesOf(page).click()
  await page.keyboard.type('the moon landing happened in 1969')
  await selectInNotes(page, 'the moon landing')
  await expect(popup(page)).toBeVisible()
  await expect(popupPromptButton(page, selectionTitle)).toBeVisible()
  await expect(popup(page).locator('.selection-popup-action', { hasText: panelTitle })).toHaveCount(0)

  await deleteCustomPrompt(page, selectionTitle)
  await deleteCustomPrompt(page, panelTitle)
})

test('guest gating on a panel button mirrors the highlight popup: disabled+explained for a guest, enabled and working for the host', async ({ browser }) => {
  const setup = await browser.newPage()
  const panelTitle = await createCustomPrompt(setup, {
    title: `Gate ${suffix()}`,
    prompt: 'Give a one-line fun fact.',
    outputFormat: 'text'
  })
  await setup.close()

  const host = await browser.newPage()
  await stubYouTubeApi(host)
  // Must be registered BEFORE createRoom below opens the room's WebSocket —
  // page.routeWebSocket only intercepts connections opened after it's
  // installed, never retroactively (see mockCustomPromptOutcomes' own doc
  // comment in helpers.js).
  await mockCustomPromptOutcomes(host, {
    [panelTitle]: { answer: 'A mocked fun fact about podcasting.', citations: [] }
  })
  const password = 'custom-prompt-gate'
  const roomUrl = await createRoom(host, { name: `E2E CustomPromptGate ${Date.now()}`, password })

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Guest', password })

  // Guest Research Access is off by default (createRoom's guestAiAllowed
  // defaults false) — the guest sees the button (never hidden — see
  // panelPromptButtons' own "always show it, disabled with a reason"
  // philosophy) but cannot run it.
  const guestBtn = panelPromptButton(guest, panelTitle)
  await expect(guestBtn).toBeVisible()
  await expect(guestBtn).toBeDisabled()
  await expect(guestBtn).toHaveAttribute('title', 'Only the host can run a prompt in this room')

  // The host's own button for the exact same prompt is enabled...
  const hostBtn = panelPromptButton(host, panelTitle)
  await expect(hostBtn).toBeEnabled()
  await expect(hostBtn).toHaveAttribute('title', `Run “${panelTitle}”`)

  // ...and actually works: clicking it produces a real, genuinely
  // server-broadcast pending entry (items 2+3), which then resolves to
  // answered with the prompt's own title standing in for a typed question.
  await hostBtn.click()
  await expect(host.locator('.research-entry[data-status="pending"]', { hasText: panelTitle })).toBeVisible()
  const entry = host.locator('.research-entry[data-status="answered"]', { hasText: panelTitle })
  await expect(entry).toBeVisible({ timeout: 10_000 })
  await expect(entry.locator('.research-question')).toHaveText(panelTitle)
  await expect(entry.locator('.research-answer')).toHaveText('A mocked fun fact about podcasting.')

  await guest.close()
  await host.close()

  const cleanup = await browser.newPage()
  await deleteCustomPrompt(cleanup, panelTitle)
  await cleanup.close()
})

test('each Block type renders as real markup, in both the Annotation list (a Card) and the research entries list', async ({ page }) => {
  await stubYouTubeApi(page)

  const cardTitle = await createCustomPrompt(page, {
    title: `CardBlk ${suffix()}`,
    prompt: 'Break down: {selection}',
    outputFormat: 'blocks'
  })
  const entryTitle = await createCustomPrompt(page, {
    title: `EntryBlk ${suffix()}`,
    prompt: 'Give a structured fun fact.',
    outputFormat: 'blocks'
  })

  // Must be registered BEFORE createRoom below opens the room's WebSocket —
  // page.routeWebSocket only intercepts connections opened after it's
  // installed, never retroactively (see mockCustomPromptOutcomes' own doc
  // comment in helpers.js).
  await mockCustomPromptOutcomes(page, {
    [cardTitle]: { answer: 'Flattened fallback text, never shown once blocks exist.', blocks: SAMPLE_BLOCKS },
    [entryTitle]: { answer: 'Flattened fallback text, never shown once blocks exist.', blocks: SAMPLE_BLOCKS }
  })

  await createRoom(page, { name: `E2E CustomPromptBlocks ${Date.now()}`, password: 'custom-prompt-blocks' })

  // ── Card (Annotation list), triggered from a highlight ────────────────
  await notesOf(page).click()
  await page.keyboard.type('the moon landing happened in 1969')
  await selectInNotes(page, 'the moon landing')
  await expect(popup(page)).toBeVisible()
  await popupPromptButton(page, cardTitle).click()

  const card = page.locator('[data-testid="annotation"][data-status="answered"]', { hasText: cardTitle })
  await expect(card).toBeVisible({ timeout: 10_000 })
  await assertBlocksRendered(card)

  // ── Research entry, triggered from a panel button ──────────────────────
  await panelPromptButton(page, entryTitle).click()
  const entry = page.locator('.research-entry[data-status="answered"]', { hasText: entryTitle })
  await expect(entry).toBeVisible({ timeout: 10_000 })
  await assertBlocksRendered(entry)

  await deleteCustomPrompt(page, cardTitle)
  await deleteCustomPrompt(page, entryTitle)
})

/** Real markup, not text a reader has to parse themselves (ticket 03's own
 *  framing) — asserted on tag/role, not just visible text, so a future
 *  regression to bullet-characters-in-a-paragraph would actually fail this. */
async function assertBlocksRendered(container) {
  const blockList = container.locator('[data-testid="block-list"]')
  await expect(blockList).toBeVisible()

  await expect(blockList.locator('[data-testid="block-paragraph"]')).toHaveText('Straight prose, no markdown syntax in it.')
  expect(await blockList.locator('[data-testid="block-paragraph"]').evaluate((el) => el.tagName)).toBe('P')

  const list = blockList.locator('[data-testid="block-list-items"]')
  expect(await list.evaluate((el) => el.tagName)).toBe('UL')
  const items = list.locator('[data-testid="block-list-item"]')
  await expect(items).toHaveCount(2)
  expect(await items.nth(0).evaluate((el) => el.tagName)).toBe('LI')
  await expect(items.nth(0)).toHaveText('First point')
  await expect(items.nth(1)).toHaveText('Second point')

  const stat = blockList.locator('[data-testid="block-stat"]')
  await expect(stat.locator('[data-testid="block-stat-label"]')).toHaveText('Runtime')
  await expect(stat.locator('[data-testid="block-stat-value"]')).toHaveText('42 minutes')

  // No literal markdown syntax anywhere in the structured reply — the
  // whole point of a typed Block schema over freeform text asked to
  // "please don't use markdown".
  const wholeText = await blockList.innerText()
  expect(wholeText).not.toMatch(/[*#]/)
}

test('the pre-existing plain-text path is untouched: typed Ask, and a Freeform Custom Prompt in both surfaces', async ({ page }) => {
  await stubYouTubeApi(page)

  const cardTextTitle = await createCustomPrompt(page, {
    title: `CardTxt ${suffix()}`,
    prompt: 'Note something about: {selection}',
    outputFormat: 'text'
  })
  const entryTextTitle = await createCustomPrompt(page, {
    title: `EntryTxt ${suffix()}`,
    prompt: 'Say one thing.',
    outputFormat: 'text'
  })

  // Must be registered BEFORE createRoom below opens the room's WebSocket —
  // page.routeWebSocket only intercepts connections opened after it's
  // installed, never retroactively (see mockCustomPromptOutcomes' own doc
  // comment in helpers.js). mockResearchEndpoint below is an HTTP
  // page.route(), which has no such ordering constraint — it intercepts any
  // matching future request regardless of when it's registered relative to
  // navigation, so it stays where it naturally reads, right before the ask.
  await mockCustomPromptOutcomes(page, {
    [cardTextTitle]: { answer: 'A plain-text Card answer, no blocks.', blocks: null },
    [entryTextTitle]: { answer: 'A plain-text research entry answer, no blocks.', blocks: null }
  })

  await createRoom(page, { name: `E2E CustomPromptPlainText ${Date.now()}`, password: 'custom-prompt-plaintext' })

  // ── Typed Ask (client-driven, unrelated to Custom Prompts) — the exact
  //    DOM shape research_panel.spec.js's own manual-ask test already
  //    asserts, repeated here as this ticket's own explicit regression
  //    check rather than borrowed by reference. ──────────────────────────
  await mockResearchEndpoint(page, { status: 200, body: { answer: 'A haiku is a three-line poem.', citations: [] } })
  await page.getByLabel('Ask the Research Assistant').fill('What is a haiku?')
  await page.getByRole('button', { name: 'Ask' }).click()
  const askEntry = page.locator('.research-entry[data-status="answered"]', { hasText: 'What is a haiku?' })
  await expect(askEntry).toBeVisible({ timeout: 10_000 })
  await expect(askEntry.locator('.research-answer')).toHaveText('A haiku is a three-line poem.')
  await expect(askEntry.locator('[data-testid="block-list"]')).toHaveCount(0)

  // ── A Freeform Custom Prompt's Card (highlight-triggered) ──────────────
  await notesOf(page).click()
  await page.keyboard.type('the moon landing happened in 1969')
  await selectInNotes(page, 'the moon landing')
  await expect(popup(page)).toBeVisible()
  await popupPromptButton(page, cardTextTitle).click()
  const card = page.locator('[data-testid="annotation"][data-status="answered"]', { hasText: cardTextTitle })
  await expect(card).toBeVisible({ timeout: 10_000 })
  // Exactly the pre-ticket-03 markup: a bare <p class="annotation-text">,
  // no BlockList mounted alongside or instead of it.
  await expect(card.locator('p.annotation-text')).toHaveText('A plain-text Card answer, no blocks.')
  await expect(card.locator('[data-testid="block-list"]')).toHaveCount(0)

  // ── A Freeform Custom Prompt's research entry (panel-button-triggered) ─
  await panelPromptButton(page, entryTextTitle).click()
  const entry = page.locator('.research-entry[data-status="answered"]', { hasText: entryTextTitle })
  await expect(entry).toBeVisible({ timeout: 10_000 })
  // Exactly the pre-ticket-03 markup: parseResearchCard's fallback card
  // (no recognized OUTPUT TYPE label) renders under .research-card >
  // .research-answer, not .research-interpretation and not a BlockList.
  await expect(entry.locator('.research-card .research-answer')).toHaveText('A plain-text research entry answer, no blocks.')
  await expect(entry.locator('[data-testid="block-list"]')).toHaveCount(0)

  await deleteCustomPrompt(page, cardTextTitle)
  await deleteCustomPrompt(page, entryTextTitle)
})
