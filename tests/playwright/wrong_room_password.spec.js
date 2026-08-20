import { test, expect } from '@playwright/test'
import { stubYouTubeApi, createRoom, fillField } from './helpers.js'

test('wrong room password shows an error', async ({ browser }) => {
  const host = await browser.newPage()
  await stubYouTubeApi(host)
  const roomUrl = await createRoom(host, { name: `E2E WrongRoomPw ${Date.now()}`, password: 'real-pass' })

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await guest.goto(roomUrl)
  await fillField(guest.getByLabel('Your name'), 'Guest')
  await fillField(guest.locator('#room-episode-code'), 'nope')
  await guest.getByRole('button', { name: /Join Room/i }).click()

  await expect(guest.getByText('Wrong password. Try again.')).toBeVisible()
  await expect(guest.getByRole('button', { name: /Join Room/i })).toBeVisible()

  await guest.close()
  await host.close()
})
