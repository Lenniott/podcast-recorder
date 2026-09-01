import { test, expect } from '@playwright/test'
import { stubYouTubeApi, createRoom, joinAsGuest, trackLiveSockets } from './helpers.js'

/**
 * Manual "Research recent conversation" button — the cheap, human-triggered
 * validation step for what was going to be Research Mode's fully
 * autonomous Gate/Deep Check pipeline (deferred, see
 * docs/adr/0004-research-mode-replaces-voice-trigger.md and ticket 06's
 * current status). Reuses ticket 04's research_ask/resolve/error mechanism
 * exactly like Quick Actions do (see research_quick_actions.spec.js) — the
 * only new thing is the request body (Focus = last 10 minutes as `context`,
 * Grounding = older transcript as `notes`, no `query`) and when the button
 * is enabled at all.
 *
 * The 10-minute split and the 20k trim are unit-tested (buildRecentTranscriptRequest,
 * tests/unit/research-panel.test.js) with an injected clock — not
 * re-proven here, since an e2e spec can't practically wait 10 real minutes
 * to age `at`. Injected live lines all stamp `at = Date.now()`, so this spec
 * still sees `notes: ''`.
 */

const RECENT_LABEL = 'Research recent conversation'

async function captureResearchRequests(page, { status = 200, body = { answer: 'Mocked answer.', citations: [] }, delayMs = 0 } = {}) {
  const requests = []
  await page.route('**/rec/*/research', async (route) => {
    requests.push(route.request().postDataJSON())
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  })
  return requests
}

async function sendTranscriptLine(page, { speaker, text }) {
  await page.evaluate(
    ({ speaker, text }) => {
      window.__prLiveSockets[0].send(JSON.stringify({ type: 'transcript_line', speaker, text }))
    },
    { speaker, text }
  )
}

test('the button is disabled with no transcript yet, and enables once conversation is captured', async ({ page }) => {
  await trackLiveSockets(page)
  await stubYouTubeApi(page)
  const password = 'research-recent-disabled'
  await createRoom(page, { name: `E2E ResearchRecentDisabled ${Date.now()}`, password })

  await expect(page.getByRole('button', { name: RECENT_LABEL })).toBeDisabled()

  await sendTranscriptLine(page, { speaker: 'Host', text: 'Let\'s talk about the history of the printing press.' })
  await expect(page.getByRole('button', { name: RECENT_LABEL })).toBeEnabled()

  await page.close()
})

test('clicking it sends the recent transcript as context with no query, and shows the answer to both peers', async ({ browser }) => {
  const host = await browser.newPage()
  await trackLiveSockets(host)
  await stubYouTubeApi(host)
  const password = 'research-recent-basic'
  const roomUrl = await createRoom(host, { name: `E2E ResearchRecentBasic ${Date.now()}`, password })

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Guest', password })

  await sendTranscriptLine(host, { speaker: 'Host', text: 'The Gutenberg press was invented around 1440.' })
  await sendTranscriptLine(host, { speaker: 'Guest', text: 'Was it really that influential?' })
  await expect(host.getByRole('button', { name: RECENT_LABEL })).toBeEnabled()

  const requests = await captureResearchRequests(host, {
    delayMs: 300,
    body: {
      answer: 'The printing press dramatically increased literacy across Europe.',
      citations: [{ url: 'https://example.com/press', title: 'Printing press' }]
    }
  })

  await host.getByRole('button', { name: RECENT_LABEL }).click()

  await expect(host.locator('.research-entry[data-status="pending"]')).toBeVisible()
  await expect(host.locator('.research-question')).toHaveText(RECENT_LABEL)
  await expect(host.locator('.research-entry[data-status="answered"]')).toBeVisible({ timeout: 10_000 })
  await expect(host.locator('.research-answer')).toHaveText('The printing press dramatically increased literacy across Europe.')
  await expect(host.locator('.research-citations a')).toHaveText('Printing press')

  expect(requests).toEqual([
    {
      kind: 'voice',
      query: null,
      context: 'Host: The Gutenberg press was invented around 1440.\nGuest: Was it really that influential?',
      notes: ''
    }
  ])

  // Shared with the guest too, same broadcast mechanism ticket 04 proved.
  await expect(guest.locator('.research-entry[data-status="answered"]')).toBeVisible({ timeout: 15_000 })
  await expect(guest.locator('.research-question')).toHaveText(RECENT_LABEL)

  await guest.close()
  await host.close()
})

test('a failed request resolves to a visible error, never a stuck pending card', async ({ page }) => {
  await trackLiveSockets(page)
  await stubYouTubeApi(page)
  const password = 'research-recent-error'
  await createRoom(page, { name: `E2E ResearchRecentError ${Date.now()}`, password })

  await sendTranscriptLine(page, { speaker: 'Host', text: 'Something worth checking, maybe.' })
  await expect(page.getByRole('button', { name: RECENT_LABEL })).toBeEnabled()

  await captureResearchRequests(page, { status: 502, body: { error: 'UPSTREAM_ERROR' } })
  await page.getByRole('button', { name: RECENT_LABEL }).click()

  await expect(page.locator('.research-entry[data-status="errored"]')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.research-error-text')).toContainText(/could not be reached/i)

  await page.close()
})
