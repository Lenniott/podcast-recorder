import { test, expect } from '@playwright/test'
import { stubYouTubeApi, fillField, openCreateRoom, trackLiveSockets, roomTabsReady } from './helpers.js'

/**
 * Friend login (friend-password-auth, ticket 02) — a second, weaker login
 * on the same entry page SITE_PASSWORD gates today, reached with its own
 * FRIEND_PASSWORD. See CONTEXT.md's **Friend**/**Friend room** entries and
 * .scratch/friend-password-auth/issues/02-friend-login-ai-off-dashboard-block.md.
 *
 * Like wrong_site_password.spec.js, this only actually exercises anything
 * when the server under test has both SITE_PASSWORD and FRIEND_PASSWORD
 * configured — playwright.config.js's shared e2e webServer deliberately
 * blanks SITE_PASSWORD for every other spec's isolation/speed, so a normal
 * `npm run test:e2e` run skips this spec rather than failing. Run it for
 * real against a server started with both env vars set to actually cover
 * this path.
 */

const askInput = (page) => page.getByLabel('Ask the Research Assistant')
const transcriptFacetButton = (page) => page.getByTestId('facet-transcript')

async function friendLogin(page, password) {
  await page.goto('/')
  const friendField = page.getByRole('textbox', { name: 'Friend Password' })
  const newRoom = page.getByRole('button', { name: 'New room' })
  await expect(friendField.or(newRoom)).toBeVisible({ timeout: 15_000 })
  test.skip(!(await friendField.isVisible()), 'Friend login gate is off (FRIEND_PASSWORD not set on this server)')
  await friendField.fill(password)
  await page.getByRole('button', { name: 'Unlock' }).click()
  await expect(newRoom).toBeVisible({ timeout: 15_000 })
}

async function createRoomAsFriend(page, { name, password }) {
  await friendLogin(page, process.env.FRIEND_PASSWORD || '')
  await openCreateRoom(page)
  await fillField(page.locator('#room-episode-name'), name)
  await fillField(page.locator('#room-episode-code'), password)
  // The AI checkbox is never shown to a Friend session — see CreateEpisodeForm.svelte's hideAiToggle.
  await expect(page.getByRole('checkbox', { name: 'Guest AI access' })).toHaveCount(0)
  await Promise.all([
    page.waitForURL(/\/rec\//, { timeout: 30_000 }),
    page.getByRole('button', { name: /Create Room/i }).click()
  ])
  await fillField(page.getByLabel('Your name'), 'Friend Host')
  await page.getByRole('button', { name: /Continue/i }).click()
  await roomTabsReady(page)
  return page.url()
}

test('Friend login creates an AI-off room; Transcript still works; Host sees it flagged in the dashboard', async ({ browser }) => {
  const friend = await browser.newPage()
  await trackLiveSockets(friend)
  await stubYouTubeApi(friend)

  const roomName = `E2E FriendRoom ${Date.now()}`
  const roomUrl = await createRoomAsFriend(friend, { name: roomName, password: 'friend-room-pass' })
  expect(roomUrl).toMatch(/\/rec\//)

  // ── No AI UI at all in a Friend room ─────────────────────────────────
  await expect(askInput(friend)).toHaveCount(0)

  // ── Transcript keeps working exactly as in a Host room — untouched by
  //    this ticket — proved end to end via a real transcript_line over the
  //    room's live WebSocket, same as transcript_panel_facet.spec.js. ────
  await transcriptFacetButton(friend).click()
  await friend.evaluate(() => {
    window.__prLiveSockets[0].send(JSON.stringify({
      type: 'transcript_line',
      speaker: 'Friend Host',
      text: 'This is a Friend room and Transcript still works.'
    }))
  })
  await expect(friend.getByText('This is a Friend room and Transcript still works.')).toBeVisible()

  // ── Host logs in separately and sees the Friend room flagged in the
  //    dashboard's room list, with their own AI toggle unaffected. ──────
  const hostContext = await browser.newContext()
  const host = await hostContext.newPage()
  await host.goto('/')
  const siteField = host.getByRole('textbox', { name: 'Site Password' })
  if (await siteField.isVisible()) {
    await siteField.fill(process.env.SITE_PASSWORD || '')
    await host.getByRole('button', { name: 'Unlock' }).click()
  }
  await expect(host.getByRole('button', { name: 'New room' })).toBeVisible({ timeout: 15_000 })

  const friendRow = host.locator('.dashboard-table tbody tr', { hasText: roomName })
  await expect(friendRow).toBeVisible({ timeout: 15_000 })
  await expect(friendRow.getByText('Friend', { exact: true })).toBeVisible()

  // Host's own room creation still offers the AI checkbox, unaffected.
  await openCreateRoom(host)
  await expect(host.getByRole('checkbox', { name: 'Guest AI access' })).toBeVisible()
})
