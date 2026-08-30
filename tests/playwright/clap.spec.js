import { test, expect } from '@playwright/test'
import { stubYouTubeApi, createRoom, joinAsGuest } from './helpers.js'

test('clap flashes on both browsers', async ({ browser }) => {
  const host = await browser.newPage()
  await stubYouTubeApi(host)
  const password = 'clap'
  const roomUrl = await createRoom(host, { name: `E2E Clap ${Date.now()}`, password, hostDisplayName: 'Host' })

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Alex', password })

  await expect(host.getByRole('button', { name: 'Sync Tone Marker' })).toBeEnabled()
  await host.getByRole('button', { name: 'Sync Tone Marker' }).click()

  await expect(host.locator('.clap-flash')).toContainText('from Host', { timeout: 15_000 })
  await expect(guest.locator('.clap-flash')).toContainText('from Host', { timeout: 15_000 })

  await guest.close()
  await host.close()
})
