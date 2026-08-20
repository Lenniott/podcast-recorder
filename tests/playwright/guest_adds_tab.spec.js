import { test, expect } from '@playwright/test'
import { stubYouTubeApi, createRoom, joinAsGuest } from './helpers.js'

test('a guest can add a tab and it becomes active for the host too', async ({ browser }) => {
  const host = await browser.newPage()
  await stubYouTubeApi(host)
  const password = 'guest-add-tab'
  const roomUrl = await createRoom(host, { name: `E2E GuestAddTab ${Date.now()}`, password })

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Guest', password })

  await guest.getByRole('button', { name: 'Add tab' }).click()

  await expect(guest.locator('.tab-pill.active')).toContainText('Tab 2')
  await expect(host.locator('.tab-pill.active')).toContainText('Tab 2', { timeout: 15_000 })

  await guest.close()
  await host.close()
})
