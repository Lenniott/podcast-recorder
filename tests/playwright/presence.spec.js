import { test, expect } from '@playwright/test'
import { stubYouTubeApi, createRoom, joinAsGuest } from './helpers.js'

test('host and guest see each other in presence with role pills', async ({ browser }) => {
  const host = await browser.newPage()
  await stubYouTubeApi(host)
  const password = 'presence'
  const roomUrl = await createRoom(host, { name: `E2E Presence ${Date.now()}`, password, hostDisplayName: 'Host' })

  await expect(host.locator('.peer-name', { hasText: 'Host' })).toBeVisible()

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Alex', password })

  await expect(host.locator('.peer-name', { hasText: 'Alex' })).toBeVisible({ timeout: 15_000 })
  await expect(host.locator('.peer', { hasText: 'Alex' }).locator('.pill-guest')).toBeVisible()
  await expect(guest.locator('.peer-name', { hasText: 'Host' })).toBeVisible()
  await expect(guest.locator('.peer', { hasText: 'Host' }).locator('.pill-host')).toBeVisible()
  await expect(host.getByText('Password:')).toBeVisible()
  await expect(guest.getByText('Password:')).toHaveCount(0)

  await guest.close()
  await host.close()
})
