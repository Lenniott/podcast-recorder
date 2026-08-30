import { test, expect } from '@playwright/test'
import { stubYouTubeApi, createRoom, joinAsGuest, expandPresenceTable, presenceRow } from './helpers.js'

test('host and guest see each other in presence with role pills', async ({ browser }) => {
  const host = await browser.newPage()
  await stubYouTubeApi(host)
  const password = 'presence'
  const roomUrl = await createRoom(host, { name: `E2E Presence ${Date.now()}`, password, hostDisplayName: 'Host' })

  await expect(host.getByTestId('presence-fold')).toContainText('Waiting for guest')

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Alex', password })

  await expect(host.locator('.fold-names', { hasText: 'Alex' })).toBeVisible({ timeout: 15_000 })
  await expect(guest.locator('.fold-names', { hasText: 'Host' })).toBeVisible()
  await expandPresenceTable(host)
  await expect(presenceRow(host, 'Alex').locator('.pill-guest')).toBeVisible()
  await expandPresenceTable(guest)
  await expect(presenceRow(guest, 'Host').locator('.pill-host')).toBeVisible()
  await expect(host.getByText('Password:')).toBeVisible()
  await expect(guest.getByText('Password:')).toHaveCount(0)

  await guest.close()
  await host.close()
})
