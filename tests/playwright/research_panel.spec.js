import { test, expect } from '@playwright/test'
import { stubYouTubeApi, createRoom, joinAsGuest, mockCustomPromptOutcomes } from './helpers.js'

const askAnswer = (text) => JSON.stringify({ provenInTranscript: 0, ubiquitousKnowledge: 0, outputType: 'ask', mainTakeaway: text })
const paragraph = (text) => [{ type: 'paragraph', text }]

const askInput = (page) => page.getByLabel('Ask the Research Assistant')
const askButton = (page) => page.getByRole('button', { name: 'Ask' })

async function askQuestion(page, question) {
  await askInput(page).fill(question)
  await askButton(page).click()
}

test('manual ask: goes pending then answered with citations, shared with the other peer', async ({ browser }) => {
  const host = await browser.newPage()
  await stubYouTubeApi(host)
  await mockCustomPromptOutcomes(host, {
    'What is a haiku?': { answer: askAnswer('A haiku is a three-line Japanese poem.'), blocks: paragraph('A haiku is a three-line Japanese poem.'), citations: [{ url: 'https://example.com/haiku', title: 'Haiku basics' }] }
  })
  const password = 'research-panel-test'
  const roomUrl = await createRoom(host, { name: `E2E Research ${Date.now()}`, password })

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await mockCustomPromptOutcomes(guest, {
    'What is a haiku?': { answer: askAnswer('A haiku is a three-line Japanese poem.'), blocks: paragraph('A haiku is a three-line Japanese poem.'), citations: [{ url: 'https://example.com/haiku', title: 'Haiku basics' }] }
  })
  await joinAsGuest(guest, roomUrl, { name: 'Guest', password })

  await askQuestion(host, 'What is a haiku?')

  // Goes pending immediately (real, server-broadcast state — not a client
  // illusion), then resolves to the answer once the (mocked, delayed)
  // server-owned lookup resolves.
  await expect(host.locator('.research-entry[data-status="pending"]')).toBeVisible()
  await expect(host.locator('.research-entry[data-status="answered"]')).toBeVisible({ timeout: 10_000 })
  await expect(host.locator('[data-testid="block-list"]')).toHaveText('A haiku is a three-line Japanese poem.')
  // Citations are collapsed behind a disclosure toggle by default.
  await host.locator('.research-citations-toggle').click()
  // Rendered as the deduped hostname, not the citation's title — see
  // dedupeCitationsByHost in research-panel.js.
  await expect(host.locator('.research-citations a')).toHaveText('example.com')
  await expect(host.locator('.research-citations a')).toHaveAttribute('href', 'https://example.com/haiku')

  // The same answer appears in the other peer's panel — neither browser
  // sent anything from the guest side, this is purely the server's broadcast.
  await expect(guest.locator('.research-entry[data-status="answered"]')).toBeVisible({ timeout: 15_000 })
  await expect(guest.locator('.research-question')).toHaveText('What is a haiku?')
  await expect(guest.locator('[data-testid="block-list"]')).toHaveText('A haiku is a three-line Japanese poem.')
  await guest.locator('.research-citations-toggle').click()
  await expect(guest.locator('.research-citations a')).toHaveText('example.com')

  await guest.close()
  await host.close()
})

test('a failed ask always resolves to a visible error, never a stuck pending card', async ({ page }) => {
  await stubYouTubeApi(page)
  const password = 'research-panel-error'
  await createRoom(page, { name: `E2E ResearchError ${Date.now()}`, password })

  await askQuestion(page, 'Define entropy.')

  await expect(page.locator('.research-entry[data-status="errored"]')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.research-error-text')).toHaveText(/not configured/i)
  // Never left pending alongside the error.
  await expect(page.locator('.research-entry[data-status="pending"]')).toHaveCount(0)

  await page.close()
})

test('research history is scoped per tab: switching tabs shows a different, empty history', async ({ page }) => {
  await stubYouTubeApi(page)
  await mockCustomPromptOutcomes(page, {
    'Question for tab 1': { answer: askAnswer('Answer for tab 1.'), blocks: paragraph('Answer for tab 1.') }
  })
  const password = 'research-panel-tabs'
  await createRoom(page, { name: `E2E ResearchTabs ${Date.now()}`, password })
  await askQuestion(page, 'Question for tab 1')
  await expect(page.locator('.research-entry[data-status="answered"]')).toBeVisible({ timeout: 10_000 })

  // A brand-new tab starts with its own, empty research history.
  // `.research-empty` is also used for the Annotations empty copy, so
  // match the research-history sentence — not the class.
  await page.getByRole('button', { name: 'Add tab' }).click()
  await expect(page.getByRole('button', { name: 'Tab 2', exact: true })).toBeVisible()
  await expect(page.getByText('Ask a question, run a prompt, or highlight text to annotate it.')).toBeVisible()
  await expect(page.locator('.research-entry')).toHaveCount(0)

  // Switching back to the first tab shows its entry again.
  await page.getByRole('button', { name: 'Tab 1', exact: true }).click()
  await expect(page.locator('.research-entry[data-status="answered"]')).toBeVisible()
  await expect(page.locator('.research-question')).toHaveText('Question for tab 1')

  await page.close()
})

test('research history survives a room re-join', async ({ browser }) => {
  const context = await browser.newContext()
  const host = await context.newPage()
  await stubYouTubeApi(host)
  await mockCustomPromptOutcomes(host, {
    'Persisted question?': { answer: askAnswer('Persisted answer.'), blocks: paragraph('Persisted answer.') }
  })
  const password = 'research-panel-rejoin'
  const roomUrl = await createRoom(host, { name: `E2E ResearchRejoin ${Date.now()}`, password })
  await askQuestion(host, 'Persisted question?')
  await expect(host.locator('.research-entry[data-status="answered"]')).toBeVisible({ timeout: 10_000 })

  await host.close()

  const rejoined = await context.newPage()
  await stubYouTubeApi(rejoined)
  await mockCustomPromptOutcomes(rejoined, {
    'Persisted question?': { answer: askAnswer('Persisted answer.'), blocks: paragraph('Persisted answer.') }
  }, { delayMs: 0 })
  await rejoined.goto(roomUrl)
  await expect(rejoined.locator('.research-entry[data-status="answered"]')).toBeVisible({ timeout: 15_000 })
  await expect(rejoined.locator('.research-question')).toHaveText('Persisted question?')
  await expect(rejoined.locator('[data-testid="block-list"]')).toHaveText('Persisted answer.')

  await rejoined.close()
  await context.close()
})

test("the panel's own collapsed/expanded state is local, not synced between peers", async ({ browser }) => {
  const host = await browser.newPage()
  await stubYouTubeApi(host)
  const password = 'research-panel-collapse'
  const roomUrl = await createRoom(host, { name: `E2E ResearchCollapse ${Date.now()}`, password })

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Guest', password })

  // The ask input is host-only by default (Guest Research Access — a
  // per-room checkbox set at creation, see CONTEXT.md — gates it for
  // guests; ResearchPanel.svelte's canAskResearch), so expanded/collapsed
  // is asserted here via the panel title instead, which both host and
  // guest always see when expanded.
  const panelTitle = (page) => page.locator('.research-panel-title')
  await expect(askInput(host)).toBeVisible()
  await expect(panelTitle(guest)).toBeVisible()

  await host.getByRole('button', { name: 'Collapse Research Assistant' }).click()
  await expect(askInput(host)).toBeHidden()

  // The guest's own panel is untouched by the host's local UI preference.
  await expect(panelTitle(guest)).toBeVisible()
  await expect(guest.getByRole('button', { name: 'Collapse Research Assistant' })).toBeVisible()

  await guest.close()
  await host.close()
})
