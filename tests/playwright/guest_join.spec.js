import { test, expect } from '@playwright/test'
import { stubYouTubeApi, createRoom, joinAsGuest } from './helpers.js'

test('guest joins with the room password and lands on Tab 1', async ({ browser }) => {
  const host = await browser.newPage()
  await stubYouTubeApi(host)
  const password = 'guest-join'
  const roomUrl = await createRoom(host, { name: `E2E GuestJoin ${Date.now()}`, password })

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Guest', password })

  await expect(guest).toHaveURL(/\/rec\//)
  await expect(guest.getByRole('button', { name: 'Tab 1' })).toBeVisible()
  await expect(guest.getByRole('button', { name: 'Start Recording' })).toBeVisible()
  await expect(guest.getByText('Password:')).toHaveCount(0)

  await guest.close()
  await host.close()
})
