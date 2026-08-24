import { test, expect } from '@playwright/test'
import { stubYouTubeApi, createRoom, joinAsGuest } from './helpers.js'

test('starting recording flips this peer to Recording on both browsers', async ({ browser }) => {
  const host = await browser.newPage()
  await stubYouTubeApi(host)
  const password = 'rec-status'
  const roomUrl = await createRoom(host, { name: `E2E Rec ${Date.now()}`, password })

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Alex', password })

  await expect(host.getByRole('button', { name: 'Start Recording' })).toBeEnabled()
  await host.getByRole('button', { name: 'Start Recording' }).click()
  await expect(host.getByRole('button', { name: 'Stop Recording' })).toBeVisible()
  await expect(host.locator('.peer', { hasText: 'Host' }).locator('.pill-recording')).toBeVisible()
  await expect(guest.locator('.peer', { hasText: 'Host' }).locator('.pill-recording')).toBeVisible()

  await guest.close()
  await host.close()
})
