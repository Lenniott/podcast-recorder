import { test, expect } from '@playwright/test'
import { stubYouTubeApi, createRoom, joinAsGuest, trackLiveSockets } from './helpers.js'

/**
 * Ticket 05 — the five Quick Action buttons (Define, Key facts, Fact-check,
 * Find examples, Analyze). Reuses ticket 04's research_ask/resolve/error
 * mechanism (see research_panel.spec.js for that lifecycle's own coverage)
 * — these specs focus on what's new here: which text a Quick Action
 * actually sends, and when the buttons are enabled at all.
 */

const QUICK_ACTION_LABELS = ['Define', 'Key facts', 'Fact-check', 'Find examples', 'Analyze']

const notesTextarea = (page) =>
  page.getByRole('textbox', { name: 'Shared notes — visible to everyone in the room…' })

/**
 * Installs a route that both fakes the browser's own POST
 * /rec/[slug]/research call (like helpers.js's mockResearchEndpoint) AND
 * records the exact JSON body sent each time, so a test can inspect what a
 * Quick Action actually sent instead of just how the UI reacted to it.
 *
 * `delayMs` mirrors research_panel.spec.js's own mockResearchEndpointDelayed
 * — without it, a same-tick mocked response can resolve before a "pending"
 * assertion even gets a chance to poll, so any test that checks the pending
 * state passes one.
 */
async function captureResearchRequests(page, { status = 200, body = { answer: 'Mocked answer.', citations: [] }, delayMs = 0 } = {}) {
  const requests = []
  await page.route('**/rec/*/research', async (route) => {
    requests.push(route.request().postDataJSON())
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  })
  return requests
}

/**
 * Drives a `transcript_line` message straight over the room's live
 * WebSocket, same as transcript_tab.spec.js — no microphone, no mocking.
 */
async function sendTranscriptLine(page, { speaker, text }) {
  await page.evaluate(
    ({ speaker, text }) => {
      window.__prLiveSockets[0].send(JSON.stringify({ type: 'transcript_line', speaker, text }))
    },
    { speaker, text }
  )
}

test('Quick Action buttons are disabled with no text to act on, and enable once the active tab has text', async ({ browser }) => {
  const host = await browser.newPage()
  await stubYouTubeApi(host)
  const password = 'quick-actions-disabled'
  const roomUrl = await createRoom(host, { name: `E2E QuickActionsDisabled ${Date.now()}`, password })

  for (const label of QUICK_ACTION_LABELS) {
    await expect(host.getByRole('button', { name: label })).toBeDisabled()
  }

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Guest', password })
  await notesTextarea(guest).fill('Some real notes worth acting on.')

  // Real, server-broadcast tab text reaching the host — not a client
  // illusion — is what flips these from disabled to enabled.
  for (const label of QUICK_ACTION_LABELS) {
    await expect(host.getByRole('button', { name: label })).toBeEnabled({ timeout: 15_000 })
  }

  await guest.close()
  await host.close()
})

test('clicking a Quick Action creates a pending-then-answered entry using the active tab\'s full text', async ({ browser }) => {
  const host = await browser.newPage()
  await stubYouTubeApi(host)
  const password = 'quick-actions-basic'
  const roomUrl = await createRoom(host, { name: `E2E QuickActionsBasic ${Date.now()}`, password })

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Guest', password })

  const tabText = 'Photosynthesis converts light into chemical energy.'
  await notesTextarea(guest).fill(tabText)
  await expect(host.getByRole('button', { name: 'Define' })).toBeEnabled({ timeout: 15_000 })

  const requests = await captureResearchRequests(host, {
    delayMs: 300,
    body: { answer: 'Photosynthesis turns light into sugar.', citations: [{ url: 'https://example.com/photo', title: 'Photosynthesis' }] }
  })

  await host.getByRole('button', { name: 'Define' }).click()

  await expect(host.locator('.research-entry[data-status="pending"]')).toBeVisible()
  await expect(host.locator('.research-question')).toHaveText('Define')
  await expect(host.locator('.research-entry[data-status="answered"]')).toBeVisible({ timeout: 10_000 })
  await expect(host.locator('.research-answer')).toHaveText('Photosynthesis turns light into sugar.')
  await expect(host.locator('.research-citations a')).toHaveText('Photosynthesis')

  expect(requests).toEqual([{ kind: 'quickAction', actionId: 'define', text: tabText }])

  // The same entry is shared with the guest too, same mechanism ticket 04
  // already proved for the manual ask box.
  await expect(guest.locator('.research-entry[data-status="answered"]')).toBeVisible({ timeout: 15_000 })
  await expect(guest.locator('.research-question')).toHaveText('Define')

  await guest.close()
  await host.close()
})

test('a Quick Action never includes another tab\'s text, even after switching tabs', async ({ browser }) => {
  const host = await browser.newPage()
  await stubYouTubeApi(host)
  const password = 'quick-actions-scoped'
  const roomUrl = await createRoom(host, { name: `E2E QuickActionsScoped ${Date.now()}`, password })

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Guest', password })

  const tab1Text = 'Tab One is about volcanoes, lava flows, and tectonic plates.'
  const tab2Text = 'Tab Two is entirely different: stock markets, interest rates, and bonds.'

  // Guest fills Tab 1 (the default first tab), then creates and fills Tab 2
  // — both substantial, both broadcast to the host's own researchPanel.
  await notesTextarea(guest).fill(tab1Text)
  await expect(host.getByRole('button', { name: 'Analyze' })).toBeEnabled({ timeout: 15_000 })

  await guest.getByRole('button', { name: 'Add tab' }).click()
  await expect(guest.getByRole('button', { name: 'Tab 2', exact: true })).toBeVisible()
  await notesTextarea(guest).fill(tab2Text)
  // Tab 2 is now the room's active tab (creating it switched everyone to
  // it) — wait for the host's own researchPanel to have received Tab 2's
  // broadcast text before moving on, so the later "switch back to Tab 1"
  // step isn't racing this fill.
  await expect(host.getByRole('button', { name: 'Analyze' })).toBeEnabled({ timeout: 15_000 })

  const requests = await captureResearchRequests(host)

  // Tab 1 active (creating Tab 2 auto-switched everyone to it, so switch
  // back explicitly) — Quick Action must send ONLY Tab 1's text.
  await host.getByRole('button', { name: 'Tab 1', exact: true }).click()
  await expect(host.locator('.tab-pill.active')).toContainText('Tab 1')
  await expect(host.getByRole('button', { name: 'Analyze' })).toBeEnabled({ timeout: 15_000 })
  await host.getByRole('button', { name: 'Analyze' }).click()
  await expect(host.locator('.research-entry[data-status="answered"]')).toBeVisible({ timeout: 10_000 })

  expect(requests).toHaveLength(1)
  expect(requests[0]).toEqual({ kind: 'quickAction', actionId: 'analyze', text: tab1Text })
  expect(requests[0].text).not.toContain('stock markets')

  // Switch to Tab 2 — Tab 1's entry is scoped away (ticket 04's per-tab
  // history), and Quick Action must now send ONLY Tab 2's text.
  await host.getByRole('button', { name: 'Tab 2', exact: true }).click()
  await expect(host.locator('.tab-pill.active')).toContainText('Tab 2')
  await expect(host.locator('.research-entry')).toHaveCount(0)
  await expect(host.getByRole('button', { name: 'Analyze' })).toBeEnabled({ timeout: 15_000 })
  await host.getByRole('button', { name: 'Analyze' }).click()
  await expect(host.locator('.research-entry[data-status="answered"]')).toHaveCount(1, { timeout: 10_000 })

  expect(requests).toHaveLength(2)
  expect(requests[1]).toEqual({ kind: 'quickAction', actionId: 'analyze', text: tab2Text })
  expect(requests[1].text).not.toContain('volcanoes')

  await guest.close()
  await host.close()
})

test('a solo participant (no guest, ever) can run a Quick Action on their own just-typed notes', async ({ page }) => {
  // This is the scenario that was silently broken before ResearchPanel
  // read RoomTabs' own `tabTexts` directly instead of keeping a second
  // copy fed only by the tab_text broadcast: that broadcast deliberately
  // excludes the sender's own connection (see ws-rooms.js), so with only
  // one participant in the room ever, nothing would tell a second,
  // independent listener what this browser itself just typed.
  await stubYouTubeApi(page)
  const password = 'quick-actions-solo'
  await createRoom(page, { name: `E2E QuickActionsSolo ${Date.now()}`, password })

  // No one else has ever joined this room.
  for (const label of QUICK_ACTION_LABELS) {
    await expect(page.getByRole('button', { name: label })).toBeDisabled()
  }

  const soloText = 'These are my own solo notes before any guest has joined.'
  await notesTextarea(page).fill(soloText)

  // The button must enable from this browser's OWN edit — no other peer,
  // no broadcast round trip is possible here.
  await expect(page.getByRole('button', { name: 'Define' })).toBeEnabled()

  const requests = await captureResearchRequests(page, { delayMs: 300, body: { answer: 'A set of personal notes.', citations: [] } })
  await page.getByRole('button', { name: 'Define' }).click()

  await expect(page.locator('.research-entry[data-status="pending"]')).toBeVisible()
  await expect(page.locator('.research-entry[data-status="answered"]')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.research-answer')).toHaveText('A set of personal notes.')

  expect(requests).toEqual([{ kind: 'quickAction', actionId: 'define', text: soloText }])

  await page.close()
})

test('a Quick Action works against the read-only Transcript tab\'s lines-so-far', async ({ page }) => {
  await trackLiveSockets(page)
  await stubYouTubeApi(page)
  const password = 'quick-actions-transcript'
  await createRoom(page, { name: `E2E QuickActionsTranscript ${Date.now()}`, password })

  await page.getByRole('button', { name: 'Transcript' }).click()
  await expect(page.getByRole('button', { name: 'Define' })).toBeDisabled()

  await sendTranscriptLine(page, { speaker: 'Host', text: 'Welcome to the show.' })
  await sendTranscriptLine(page, { speaker: 'Guest', text: 'Thanks for having me.' })
  await expect(page.locator('.transcript-line')).toHaveCount(2)

  await expect(page.getByRole('button', { name: 'Define' })).toBeEnabled()

  const requests = await captureResearchRequests(page, { body: { answer: 'A greeting exchange.', citations: [] } })
  await page.getByRole('button', { name: 'Define' }).click()

  await expect(page.locator('.research-entry[data-status="answered"]')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.research-answer')).toHaveText('A greeting exchange.')

  expect(requests).toEqual([
    { kind: 'quickAction', actionId: 'define', text: 'Host: Welcome to the show.\nGuest: Thanks for having me.' }
  ])

  await page.close()
})

test('Fact-check renders a skim card from the labeled field response, not raw field text', async ({ page }) => {
  await trackLiveSockets(page)
  await stubYouTubeApi(page)
  await createRoom(page, { name: `E2E ResearchSkimCard ${Date.now()}`, password: 'skim-card' })

  await notesTextarea(page).fill(
    'Ben: so Jack White married his sister turned out not to be a sister and they only did that for the artistry. were they married before they were famous?'
  )
  await expect(page.getByRole('button', { name: 'Fact-check' })).toBeEnabled()

  const mainTakeaway = 'They married in 1996, before they were famous.'
  const answer = [
    'PROVEN IN TRANSCRIPT: 0',
    'UBIQUITOUS KNOWLEDGE: 0',
    'OUTPUT TYPE: factCheck',
    'CONTEXT SUMMARY: whether they married before fame',
    `MAIN TAKEAWAY: ${mainTakeaway}`,
    'SOURCES: Wikipedia'
  ].join('\n')
  await captureResearchRequests(page, {
    delayMs: 200,
    body: {
      answer,
      citations: [{ url: 'https://example.com/jack', title: 'Jack White' }]
    }
  })

  await page.getByRole('button', { name: 'Fact-check' }).click()

  await expect(page.locator('.research-entry[data-status="answered"]')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.research-answer')).toHaveText(mainTakeaway)
  await expect(page.locator('.research-answer')).not.toContainText('MAIN TAKEAWAY')
  await expect(page.locator('.research-citations a')).toHaveText('Jack White')
})
