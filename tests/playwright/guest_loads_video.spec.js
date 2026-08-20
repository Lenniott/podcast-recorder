import { test, expect } from '@playwright/test'
import { stubYouTubeApi, createRoom, joinAsGuest, loadVideo } from './helpers.js'

test('guest can load a video and the host can play it', async ({ browser }) => {
  const host = await browser.newPage()
  await stubYouTubeApi(host)
  const password = 'guest-video'
  const roomUrl = await createRoom(host, { name: `E2E GuestVideo ${Date.now()}`, password })

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Guest', password })

  await loadVideo(guest)
  await expect(host.getByRole('button', { name: '▶ Play' })).toBeVisible({ timeout: 15_000 })

  await host.getByRole('button', { name: '▶ Play' }).click()
  await expect(host.getByRole('button', { name: '⏸ Pause' })).toBeVisible()
  await expect(guest.getByRole('button', { name: '⏸ Pause' })).toBeVisible({ timeout: 15_000 })

  await guest.close()
  await host.close()
})
