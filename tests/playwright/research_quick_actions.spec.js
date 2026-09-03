import { test, expect } from '@playwright/test'
import { stubYouTubeApi, createRoom, joinAsGuest, trackLiveSockets } from './helpers.js'

function cardAnswer(takeaway, mode = 'facts') {
  return JSON.stringify({
    provenInTranscript: 0,
    ubiquitousKnowledge: 0,
    outputType: mode,
    contextSummary: 'focus turn',
    mainTakeaway: takeaway
  })
}

async function captureResearchRequests(page, { status = 200, body, delayMs = 0 } = {}) {
  const requests = []
  await page.route('**/rec/*/research', async (route) => {
    requests.push(route.request().postDataJSON())
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body ?? { answer: cardAnswer('Mocked takeaway.'), citations: [] })
    })
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

test('Turn Actions live on a hovered Turn and send Focus plus neighbor Grounding', async ({ browser }) => {
  const host = await browser.newPage()
  await trackLiveSockets(host)
  await stubYouTubeApi(host)
  const password = 'turn-actions'
  const roomUrl = await createRoom(host, { name: `E2E TurnActions ${Date.now()}`, password })

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Guest', password })

  const requests = await captureResearchRequests(host, {
    body: { answer: cardAnswer('Background on the manger story.'), citations: [] }
  })

  await host.getByRole('button', { name: 'Transcript' }).click()
  await sendTranscriptLine(host, { speaker: 'Host', text: 'I only watch TV shows in the summer.' })
  await sendTranscriptLine(host, { speaker: 'Guest', text: 'Sometimes I like to watch things on TV.' })
  await sendTranscriptLine(host, { speaker: 'Host', text: 'jesus laid in a manager' })

  await expect(host.locator('.transcript-line')).toHaveCount(3)
  const focus = host.locator('.transcript-line').nth(2)
  await focus.hover()
  await focus.getByRole('button', { name: 'Facts' }).click()

  await expect(host.locator('.research-answer')).toHaveText('Background on the manger story.', { timeout: 10_000 })
  await expect(guest.locator('.research-answer')).toHaveText('Background on the manger story.', { timeout: 15_000 })

  expect(requests).toHaveLength(1)
  expect(requests[0].kind).toBe('turnAction')
  expect(requests[0].actionId).toBe('facts')
  expect(requests[0].focus).toContain('jesus laid in a manager')
  expect(requests[0].grounding).toContain('I only watch TV shows in the summer.')
  expect(requests[0].grounding).toContain('Sometimes I like to watch things on TV.')

  await guest.close()
  await host.close()
})

test('empty Turn Action lookups do not leave a skim card in the panel', async ({ page }) => {
  await trackLiveSockets(page)
  await stubYouTubeApi(page)
  await createRoom(page, { name: `E2E TurnEmpty ${Date.now()}`, password: 'turn-empty' })

  await captureResearchRequests(page, { body: { answer: 'null', citations: [] }, delayMs: 400 })

  await page.getByRole('button', { name: 'Transcript' }).click()
  await sendTranscriptLine(page, { speaker: 'Host', text: 'hello there' })
  const line = page.locator('.transcript-line').first()
  await line.hover()
  await line.getByRole('button', { name: 'Answer' }).click()

  await expect(page.locator('.research-entry[data-status="pending"]')).toBeVisible()
  await expect(page.getByText('Looking this up…')).toBeVisible()
  await expect(page.locator('.research-entry')).toHaveCount(0, { timeout: 10_000 })
  await expect(page.getByText('No research yet for this tab.')).toBeVisible()

  await page.close()
})

test('Custom is host-only; guests do not see the button', async ({ browser }) => {
  const host = await browser.newPage()
  await stubYouTubeApi(host)
  const password = 'custom-host'
  const roomUrl = await createRoom(host, { name: `E2E Custom ${Date.now()}`, password })

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Guest', password })

  await expect(host.getByRole('button', { name: 'Interpret' })).toBeVisible()
  await expect(guest.getByRole('button', { name: 'Interpret' })).toHaveCount(0)

  await guest.close()
  await host.close()
})
