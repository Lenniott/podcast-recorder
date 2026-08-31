import { test, expect } from '@playwright/test'
import { stubYouTubeApi, createRoom, joinAsGuest, mockResearchEndpoint } from './helpers.js'

/**
 * Same shape as mockResearchEndpoint (helpers.js) but with an artificial
 * delay before fulfilling, so the pending state is reliably observable
 * before the mocked answer lands — without this, a same-tick mocked
 * response can resolve before the assertion for "pending" even gets a
 * chance to poll.
 */
async function mockResearchEndpointDelayed(page, { status = 200, body, delayMs = 300 } = {}) {
  await page.route('**/rec/*/research', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  })
}

const askInput = (page) => page.getByLabel('Ask the Research Assistant')
const askButton = (page) => page.getByRole('button', { name: 'Ask' })

async function askQuestion(page, question) {
  await askInput(page).fill(question)
  await askButton(page).click()
}

test('manual ask: goes pending then answered with citations, shared with the other peer', async ({ browser }) => {
  const host = await browser.newPage()
  await stubYouTubeApi(host)
  const password = 'research-panel-test'
  const roomUrl = await createRoom(host, { name: `E2E Research ${Date.now()}`, password })

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Guest', password })

  await mockResearchEndpointDelayed(host, {
    status: 200,
    body: {
      answer: 'A haiku is a three-line Japanese poem.',
      citations: [{ url: 'https://example.com/haiku', title: 'Haiku basics' }]
    }
  })

  await askQuestion(host, 'What is a haiku?')

  // Goes pending immediately (real, server-broadcast state — not a client
  // illusion), then resolves to the answer once the (mocked, delayed)
  // endpoint responds.
  await expect(host.locator('.research-entry[data-status="pending"]')).toBeVisible()
  await expect(host.locator('.research-entry[data-status="answered"]')).toBeVisible({ timeout: 10_000 })
  await expect(host.locator('.research-answer')).toHaveText('A haiku is a three-line Japanese poem.')
  await expect(host.locator('.research-citations a')).toHaveText('Haiku basics')
  await expect(host.locator('.research-citations a')).toHaveAttribute('href', 'https://example.com/haiku')

  // The same answer appears in the other peer's panel — neither browser
  // sent anything from the guest side, this is purely the server's broadcast.
  await expect(guest.locator('.research-entry[data-status="answered"]')).toBeVisible({ timeout: 15_000 })
  await expect(guest.locator('.research-question')).toHaveText('What is a haiku?')
  await expect(guest.locator('.research-answer')).toHaveText('A haiku is a three-line Japanese poem.')
  await expect(guest.locator('.research-citations a')).toHaveText('Haiku basics')

  await guest.close()
  await host.close()
})

test('a failed ask always resolves to a visible error, never a stuck pending card', async ({ page }) => {
  await stubYouTubeApi(page)
  const password = 'research-panel-error'
  await createRoom(page, { name: `E2E ResearchError ${Date.now()}`, password })

  await mockResearchEndpoint(page, { status: 502, body: { error: 'UPSTREAM_ERROR' } })

  await askQuestion(page, 'Define entropy.')

  await expect(page.locator('.research-entry[data-status="errored"]')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.research-error-text')).toHaveText(/could not be reached/i)
  // Never left pending alongside the error.
  await expect(page.locator('.research-entry[data-status="pending"]')).toHaveCount(0)

  await page.close()
})

test('research history is scoped per tab: switching tabs shows a different, empty history', async ({ page }) => {
  await stubYouTubeApi(page)
  const password = 'research-panel-tabs'
  await createRoom(page, { name: `E2E ResearchTabs ${Date.now()}`, password })
  await mockResearchEndpoint(page, { status: 200, body: { answer: 'Answer for tab 1.', citations: [] } })

  await askQuestion(page, 'Question for tab 1')
  await expect(page.locator('.research-entry[data-status="answered"]')).toBeVisible({ timeout: 10_000 })

  // A brand-new tab starts with its own, empty research history.
  await page.getByRole('button', { name: 'Add tab' }).click()
  await expect(page.getByRole('button', { name: 'Tab 2', exact: true })).toBeVisible()
  await expect(page.locator('.research-empty')).toBeVisible()
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
  const password = 'research-panel-rejoin'
  const roomUrl = await createRoom(host, { name: `E2E ResearchRejoin ${Date.now()}`, password })
  await mockResearchEndpoint(host, { status: 200, body: { answer: 'Persisted answer.', citations: [] } })

  await askQuestion(host, 'Persisted question?')
  await expect(host.locator('.research-entry[data-status="answered"]')).toBeVisible({ timeout: 10_000 })

  await host.close()

  const rejoined = await context.newPage()
  await stubYouTubeApi(rejoined)
  await rejoined.goto(roomUrl)
  await expect(rejoined.locator('.research-entry[data-status="answered"]')).toBeVisible({ timeout: 15_000 })
  await expect(rejoined.locator('.research-question')).toHaveText('Persisted question?')
  await expect(rejoined.locator('.research-answer')).toHaveText('Persisted answer.')

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

  await expect(askInput(host)).toBeVisible()
  await expect(askInput(guest)).toBeVisible()

  await host.getByRole('button', { name: 'Collapse Research Assistant' }).click()
  await expect(askInput(host)).toBeHidden()

  // The guest's own panel is untouched by the host's local UI preference.
  await expect(askInput(guest)).toBeVisible()
  await expect(guest.getByRole('button', { name: 'Collapse Research Assistant' })).toBeVisible()

  await guest.close()
  await host.close()
})
