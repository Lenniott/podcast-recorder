import { test, expect } from '@playwright/test'
import { stubYouTubeApi, createRoom, joinAsGuest, trackLiveSockets, closeLiveSockets } from './helpers.js'

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

test('recording pill survives a mid-take socket close and reconnect', async ({ browser }) => {
  const host = await browser.newPage()
  await trackLiveSockets(host)
  await stubYouTubeApi(host)
  const password = 'rec-resync'
  const roomUrl = await createRoom(host, { name: `E2E Rec Resync ${Date.now()}`, password })

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Alex', password })

  await expect(host.getByRole('button', { name: 'Start Recording' })).toBeEnabled()
  await host.getByRole('button', { name: 'Start Recording' }).click()
  await expect(host.getByRole('button', { name: 'Stop Recording' })).toBeVisible()
  const hostPill = guest.locator('.peer', { hasText: 'Host' }).locator('.pill-recording')
  await expect(hostPill).toBeVisible()

  await closeLiveSockets(host)
  await expect(hostPill).toBeVisible({ timeout: 15_000 })

  await guest.close()
  await host.close()
})
